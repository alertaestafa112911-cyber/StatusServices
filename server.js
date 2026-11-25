const express = require('express');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Sirve directamente los archivos desde la raíz del proyecto
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const LEVELS = {
  OK: { key: 'OK', label: 'Operativo', ordinal: 0 },
  DEGRADED: { key: 'DEGRADED', label: 'Degradado', ordinal: 1 },
  OUTAGE: { key: 'OUTAGE', label: 'Caída', ordinal: 2 },
  UNKNOWN: { key: 'UNKNOWN', label: 'Sin datos', ordinal: -1 }
};

function worst(levels) {
  const valid = levels.filter(l => l && l.key !== 'UNKNOWN');
  if (valid.length === 0) return LEVELS.UNKNOWN;
  return valid.reduce((max, curr) => (curr.ordinal > max.ordinal ? curr : max), valid[0]);
}

async function httpGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CloudStatusApp/1.0' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    let text;
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      text = buf.toString('utf16le');
    } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      buf.swap16();
      text = buf.toString('utf16le');
    } else {
      text = buf.toString('utf8');
    }
    return text.replace(/^\uFEFF/, '');
  } finally {
    clearTimeout(timeout);
  }
}

async function safe(id, name, url, fn) {
  try {
    return await fn();
  } catch (e) {
    return {
      id,
      name,
      url,
      level: LEVELS.UNKNOWN,
      incidents: [],
      services: [],
      note: '',
      error: e.message || 'Error desconocido'
    };
  }
}

function severity(text) {
  const t = (text || '').toLowerCase();
  return (t.includes('outage') || t.includes('unavailable') || t.includes('disruption'))
    ? LEVELS.OUTAGE
    : LEVELS.DEGRADED;
}

function clean(html, max = 220) {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------- Cloudflare ----------
async function cloudflare() {
  return safe('cf', 'Cloudflare', 'https://cloudflarestatus.com', async () => {
    const data = JSON.parse(await httpGet('https://cloudflarestatus.com/api/v2/components.json'));
    const all = data.components || [];

    const lvl = (s) => {
      if (s === 'operational') return LEVELS.OK;
      if (s === 'major_outage') return LEVELS.OUTAGE;
      if (['degraded_performance', 'partial_outage', 'under_maintenance'].includes(s)) return LEVELS.DEGRADED;
      return LEVELS.UNKNOWN;
    };

    const services = all
      .filter(c => c.group_id === null || lvl(c.status).key !== 'OK')
      .map(c => ({ name: c.name, level: lvl(c.status), detail: '' }))
      .sort((a, b) => b.level.ordinal - a.level.ordinal);

    let incidents = [];
    try {
      const incData = JSON.parse(await httpGet('https://cloudflarestatus.com/api/v2/incidents/unresolved.json'));
      incidents = (incData.incidents || []).map(o => ({
        name: o.name,
        level: o.impact === 'critical' ? LEVELS.OUTAGE : LEVELS.DEGRADED,
        detail: o.status || ''
      }));
    } catch (_) {}

    return {
      id: 'cf',
      name: 'Cloudflare',
      url: 'https://cloudflarestatus.com',
      level: worst([...services.map(s => s.level), ...incidents.map(i => i.level)]),
      incidents,
      services,
      note: '',
      error: null
    };
  });
}

// ---------- Google Cloud ----------
async function gcp() {
  return safe('gcp', 'Google Cloud', 'https://google.com', async () => {
    const pv = JSON.parse(await httpGet('https://google.com/products.json'));
    const productsArr = Array.isArray(pv) ? pv : (pv.products || []);
    const names = productsArr.map(p => p.title).filter(Boolean);

    const incArr = JSON.parse(await httpGet('https://google.com/incidents.json'));
    const perProduct = new Map();
    const incidents = [];

    for (const o of incArr) {
      if (o.end) continue; // Solo incidentes en curso
      const level = o.status_impact === 'SERVICE_OUTAGE' ? LEVELS.OUTAGE : LEVELS.DEGRADED;
      const titles = (o.affected_products || []).map(p => p.title).filter(Boolean);

      for (const t of titles) {
        perProduct.set(t, worst([perProduct.get(t), level]));
      }

      const titleStr = titles.slice(0, 3).join(', ') || 'Incidente';
      const extra = titles.length > 3 ? ` +${titles.length - 3}` : '';
      incidents.push({
        name: titleStr + extra,
        level,
        detail: clean(o.external_desc)
      });
    }

    const allTitles = new Set([...names, ...perProduct.keys()]);
    const services = Array.from(allTitles)
      .map(title => ({ name: title, level: perProduct.get(title) || LEVELS.OK, detail: '' }))
      .sort((a, b) => (b.level.ordinal - a.level.ordinal) || a.name.localeCompare(b.name));

    return {
      id: 'gcp',
      name: 'Google Cloud',
      url: 'https://google.com',
      level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
      incidents,
      services,
      note: '',
      error: null
    };
  });
}

// ---------- AWS ----------
const AWS_CORE_SERVICES = [
  { key: 'ec2', name: 'Amazon EC2 (Compute)' },
  { key: 's3', name: 'Amazon S3 (Storage)' },
  { key: 'rds', name: 'Amazon RDS (Databases)' },
  { key: 'lambda', name: 'AWS Lambda' },
  { key: 'cloudfront', name: 'Amazon CloudFront (CDN)' },
  { key: 'route53', name: 'Amazon Route 53 (DNS)' },
  { key: 'dynamodb', name: 'Amazon DynamoDB' },
  { key: 'eks', name: 'Amazon EKS (Kubernetes)' },
  { key: 'iam', name: 'AWS IAM (Identity)' },
  { key: 'vpc', name: 'Amazon VPC (Networking)' },
  { key: 'sqs', name: 'Amazon SQS / SNS' },
  { key: 'cloudwatch', name: 'Amazon CloudWatch' }
];

async function aws() {
  return safe('aws', 'AWS', 'https://amazon.com', async () => {
    const text = (await httpGet('https://amazon.com')).trim();
    const arr = text ? JSON.parse(text) : [];

    const serviceLevels = new Map();
    const incidents = arr
      .map(o => {
        const summary = o.summary || '';
        const low = summary.toLowerCase();
        if (low.includes('operating normally') || low.includes('[resolved]')) return null;

        const svc = o.service_name || o.service || 'AWS';
        const region = o.region_name || '';
        const lvl = severity(summary);

        const svcLow = svc.toLowerCase();
        for (const core of AWS_CORE_SERVICES) {
          if (svcLow.includes(core.key)) {
            serviceLevels.set(core.name, worst([serviceLevels.get(core.name), lvl]));
          }
        }
        if (!AWS_CORE_SERVICES.some(c => svcLow.includes(c.key))) {
          serviceLevels.set(svc, worst([serviceLevels.get(svc), lvl]));
        }

        return {
          name: region ? `${svc} · ${region}` : svc,
          level: lvl,
          detail: clean(summary)
        };
      })
      .filter(Boolean);

    const allServiceNames = new Set([
      ...AWS_CORE_SERVICES.map(c => c.name),
      ...serviceLevels.keys()
    ]);

    const services = Array.from(allServiceNames)
      .map(name => ({ name, level: serviceLevels.get(name) || LEVELS.OK, detail: '' }))
      .sort((a, b) => (b.level.ordinal - a.level.ordinal) || a.name.localeCompare(b.name));

    return {
      id: 'aws',
      name: 'AWS',
      url: 'https://amazon.com',
      level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
      incidents,
      services,
      note: 'Estado de los servicios principales de AWS cruzado con eventos públicos en curso.',
      error: null
    };
  });
}

// ---------- RSS Helper (Azure y M365) ----------
const xmlParser = new XMLParser({ ignoreAttributes: true });

async function parseRss(url) {
  const xml = await httpGet(url);
  const parsed = xmlParser.parse(xml);
  let items = [];

  if (parsed.rss?.channel?.item) {
    items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
  } else if (parsed.feed?.entry) {
    items = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
  }

  return items.map(item => {
    const title = typeof item.title === 'object' ? (item.title['#text'] || '') : (item.title || '');
    const desc = item.description || item.summary || '';
    const dateStr = item.pubDate || item.updated || item.published || '';
    const date = dateStr ? new Date(dateStr) : null;
    return {
      title: String(title),
      desc: String(typeof desc === 'object' ? (desc['#text'] || '') : desc),
      date: date && !isNaN(date.getTime()) ? date : null
    };
  });
}

async function feedProvider(id, name, page, feedUrl, note) {
  return safe(id, name, page, async () => {
    const now = Date.now();
    const entries = await parseRss(feedUrl);
    const incidents = entries
      .filter(e => {
        const txt = `${e.title} ${e.desc}`.toLowerCase();
        const hoursDiff = e.date ? (now - e.date.getTime()) / (1000 * 60 * 60) : 0;
        return !txt.includes('resolved') && (!e.date || hoursDiff < 72);
      })
      .map(e => ({
        name: clean(e.title, 120),
        level: severity(`${e.title} ${e.desc}`),
        detail: clean(e.desc)
      }));

    return {
      id,
      name,
      url: page,
      level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
      incidents,
      services: [],
      note,
      error: null
    };
  });
}

const azure = () => feedProvider(
  'az',
  'Microsoft Azure',
  'https://status.microsoft',
  'https://status.microsoft',
'Feed público de incidentes activos de Azure. Sin incidentes = operativo.'
);
const m365 = () => feedProvider(
'm365',
'Microsoft 365',
'cloud.microsoft',
'cloud.microsoft',
'Feed público de incidentes de Microsoft 365 (últimas 72 h, sin resueltos).'
);
app.get('/api/status', async (req, res) => {
const providers = await Promise.all([m365(), azure(), aws(), gcp(), cloudflare()]);
const updated = new Date().toLocaleTimeString('es-ES', { hour12: false });
res.json({ providers, updated });
});
app.listen(PORT, () => {
console.log(Servidor CloudStatus escuchando en http://localhost:${PORT});
});
