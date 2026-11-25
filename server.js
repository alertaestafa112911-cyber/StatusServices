const express = require('express');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3000;

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
  const valid = levels.filter(l => l && typeof l.ordinal === 'number' && l.key !== 'UNKNOWN');
  if (valid.length === 0) return LEVELS.UNKNOWN;
  return valid.reduce((max, curr) => (curr.ordinal > max.ordinal ? curr : max), valid.at(0));
}

async function httpGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, application/xml, text/xml, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    let text;
    if (buf.length >= 2 && buf.at(0) === 0xFF && buf.at(1) === 0xFE) {
      text = buf.toString('utf16le');
    } else if (buf.length >= 2 && buf.at(0) === 0xFE && buf.at(1) === 0xFF) {
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

async function httpGetAny(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await httpGet(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No se pudo conectar');
}

async function safe(id, name, url, fn) {
  try {
    return await fn();
  } catch (e) {
    return {
      id: id,
      name: name,
      url: url,
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
  return (t.includes('outage') || t.includes('unavailable') || t.includes('disruption') || t.includes('interruption'))
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

const xmlParser = new XMLParser({ ignoreAttributes: true });

async function parseRssUrls(urls) {
  const xml = await httpGetAny(urls);
  const parsed = xmlParser.parse(xml);
  let items = [];

  if (parsed.rss && parsed.rss.channel && parsed.rss.channel.item) {
    items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
  } else if (parsed.feed && parsed.feed.entry) {
    items = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
  }

  return items.map(item => {
    const title = typeof item.title === 'object' ? (item.title['#text'] || '') : (item.title || '');
    const desc = item.description || item.summary || item.content || '';
    const dateStr = item.pubDate || item.updated || item.published || '';
    const date = dateStr ? new Date(dateStr) : null;
    return {
      title: String(title),
      desc: String(typeof desc === 'object' ? (desc['#text'] || '') : desc),
      date: date && !isNaN(date.getTime()) ? date : null
    };
  });
}

function mapCoreServices(coreList, incidents) {
  const serviceLevels = new Map();
  for (const inc of incidents) {
    const low = (inc.name + ' ' + inc.detail).toLowerCase();
    for (const core of coreList) {
      if (core.keys.some(k => low.includes(k))) {
        serviceLevels.set(core.name, worst([serviceLevels.get(core.name), inc.level]));
      }
    }
  }
  return coreList
    .map(c => ({ name: c.name, level: serviceLevels.get(c.name) || LEVELS.OK, detail: '' }))
    .sort((a, b) => (b.level.ordinal - a.level.ordinal) || a.name.localeCompare(b.name));
}

async function cloudflare() {
  return safe('cf', 'Cloudflare', 'https://www.cloudflarestatus.com', async () => {
    const data = JSON.parse(await httpGet('https://www.cloudflarestatus.com/api/v2/components.json'));
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
      const incData = JSON.parse(await httpGet('https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json'));
      incidents = (incData.incidents || []).map(o => ({
        name: o.name,
        level: o.impact === 'critical' ? LEVELS.OUTAGE : LEVELS.DEGRADED,
        detail: o.status || ''
      }));
    } catch (_) {}

    return {
      id: 'cf',
      name: 'Cloudflare',
      url: 'https://www.cloudflarestatus.com',
      level: worst([...services.map(s => s.level), ...incidents.map(i => i.level)]),
      incidents: incidents,
      services: services,
      note: '',
      error: null
    };
  });
}

const GCP_CORE_SERVICES = [
  { keys: ['compute engine', 'vm'], name: 'Compute Engine' },
  { keys: ['kubernetes', 'gke'], name: 'Google Kubernetes Engine (GKE)' },
  { keys: ['cloud storage', 'gcs'], name: 'Cloud Storage' },
  { keys: ['cloud sql'], name: 'Cloud SQL' },
  { keys: ['bigquery'], name: 'BigQuery' },
  { keys: ['cloud run'], name: 'Cloud Run' },
  { keys: ['cloud functions'], name: 'Cloud Functions' },
  { keys: ['vertex ai', 'gemini'], name: 'Vertex AI / Gemini' },
  { keys: ['vpc', 'cloud dns', 'load balancing', 'network'], name: 'Cloud Networking & DNS' },
  { keys: ['iam', 'identity'], name: 'Cloud IAM & Identity' },
  { keys: ['firestore', 'spanner', 'bigtable'], name: 'Firestore / Spanner / Bigtable' },
  { keys: ['pub/sub'], name: 'Cloud Pub/Sub' }
];

async function gcp() {
  return safe('gcp', 'Google Cloud', 'https://status.cloud.google.com', async () => {
    const now = Date.now();
    const incidents = [];
    let extraProducts = [];

    try {
      const pv = JSON.parse(await httpGet('https://status.cloud.google.com/products.json'));
      const productsArr = Array.isArray(pv) ? pv : (pv.products || []);
      extraProducts = productsArr.map(p => p.title).filter(Boolean);
    } catch (_) {}

    const entries = await parseRssUrls([
      'https://status.cloud.google.com/en/feed.atom',
      'https://status.cloud.google.com/feed.atom'
    ]);

    for (const e of entries) {
      const txt = (e.title + ' ' + e.desc).toLowerCase();
      const hoursDiff = e.date ? (now - e.date.getTime()) / (1000 * 60 * 60) : 0;
      if (txt.includes('resolved') || txt.includes('mitigated')) continue;
      if (e.date && hoursDiff > 48) continue;

      incidents.push({
        name: clean(e.title, 120),
        level: severity(txt),
        detail: clean(e.desc)
      });
    }

    let services;
    if (extraProducts.length > 0) {
      const perProduct = new Map();
      for (const inc of incidents) {
        const low = (inc.name + ' ' + inc.detail).toLowerCase();
        for (const prod of extraProducts) {
          if (low.includes(prod.toLowerCase())) {
            perProduct.set(prod, worst([perProduct.get(prod), inc.level]));
          }
        }
      }
      services = Array.from(new Set(extraProducts))
        .map(title => ({ name: title, level: perProduct.get(title) || LEVELS.OK, detail: '' }))
        .sort((a, b) => (b.level.ordinal - a.level.ordinal) || a.name.localeCompare(b.name));
    } else {
      services = mapCoreServices(GCP_CORE_SERVICES, incidents);
    }

    return {
      id: 'gcp',
      name: 'Google Cloud',
      url: 'https://status.cloud.google.com',
      level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
      incidents: incidents,
      services: services,
      note: 'Feed oficial de Google Cloud Service Health.',
      error: null
    };
  });
}

const AWS_CORE_SERVICES = [
  { keys: ['ec2'], name: 'Amazon EC2 (Compute)' },
  { keys: ['s3'], name: 'Amazon S3 (Storage)' },
  { keys: ['rds'], name: 'Amazon RDS (Databases)' },
  { keys: ['lambda'], name: 'AWS Lambda' },
  { keys: ['cloudfront'], name: 'Amazon CloudFront (CDN)' },
  { keys: ['route53', 'route 53'], name: 'Amazon Route 53 (DNS)' },
  { keys: ['dynamodb'], name: 'Amazon DynamoDB' },
  { keys: ['eks'], name: 'Amazon EKS (Kubernetes)' },
  { keys: ['iam'], name: 'AWS IAM (Identity)' },
  { keys: ['vpc'], name: 'Amazon VPC (Networking)' },
  { keys: ['sqs', 'sns'], name: 'Amazon SQS / SNS' },
  { keys: ['cloudwatch'], name: 'Amazon CloudWatch' }
];

async function aws() {
  return safe('aws', 'AWS', 'https://health.aws.amazon.com/health/status', async () => {
    const incidents = [];
    const now = Date.now();

    try {
      const text = (await httpGet('https://health.aws.amazon.com/public/currentevents')).trim();
      const arr = text ? JSON.parse(text) : [];
      for (const o of arr) {
        const summary = o.summary || '';
        const low = summary.toLowerCase();
        if (low.includes('operating normally') || low.includes('[resolved]')) continue;
        const svc = o.service_name || o.service || 'AWS';
        const region = o.region_name || '';
        incidents.push({
        name: region ? (svc + ' · ' + region) : svc,
level: severity(summary),
detail: clean(summary)
});
}
} catch (_) {
const entries = await parseRssUrls(['amazon.com']);
for (const e of entries) {
const txt = (e.title + ' ' + e.desc).toLowerCase();
const hoursDiff = e.date ? (now - e.date.getTime()) / (1000 * 60 * 60) : 0;
if (txt.includes('resolved') || txt.includes('operating normally')) continue;
if (e.date && hoursDiff > 48) continue;
incidents.push({
name: clean(e.title, 120),
level: severity(txt),
detail: clean(e.desc)
});
}
}
const services = mapCoreServices(AWS_CORE_SERVICES, incidents);
return {
id: 'aws',
name: 'AWS',
url: 'amazon.com',
level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
incidents: incidents,
services: services,
note: 'Servicios principales de AWS cruzados con avisos públicos recientes.',
error: null
};
});
}
const AZURE_CORE_SERVICES = [
{ keys: ['virtual machines', 'compute'], name: 'Azure Virtual Machines' },
{ keys: ['app service', 'functions'], name: 'Azure App Service & Functions' },
{ keys: ['aks', 'kubernetes'], name: 'Azure Kubernetes Service (AKS)' },
{ keys: ['storage', 'blob'], name: 'Azure Storage' },
{ keys: ['sql', 'cosmos', 'database'], name: 'Azure SQL & Cosmos DB' },
{ keys: ['entra', 'active directory', 'identity'], name: 'Microsoft Entra ID' },
{ keys: ['virtual network', 'dns', 'front door', 'application gateway'], name: 'Azure Networking & DNS' },
{ keys: ['openai', 'ai'], name: 'Azure AI / OpenAI Service' }
];
async function azure() {
return safe('az', 'Microsoft Azure', 'status.microsoft', async () => {
const now = Date.now();
const entries = await parseRssUrls([
'status.microsoft',
'azureedge.net',
'status.microsoft'
]);
const incidents = entries
.filter(e => {
const txt = (e.title + ' ' + e.desc).toLowerCase();
const hoursDiff = e.date ? (now - e.date.getTime()) / (1000 * 60 * 60) : 0;
return !txt.includes('resolved') && !txt.includes('mitigated') && (!e.date || hoursDiff < 72);
})
.map(e => ({
name: clean(e.title, 120),
level: severity(e.title + ' ' + e.desc),
detail: clean(e.desc)
}));
return {
id: 'az',
name: 'Microsoft Azure',
url: 'status.microsoft',
level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
incidents: incidents,
services: mapCoreServices(AZURE_CORE_SERVICES, incidents),
note: 'Feed público de estado global de Microsoft Azure.',
error: null
};
});
}
const M365_CORE_SERVICES = [
{ keys: ['exchange', 'outlook', 'mail'], name: 'Exchange Online' },
{ keys: ['teams'], name: 'Microsoft Teams' },
{ keys: ['sharepoint'], name: 'SharePoint Online' },
{ keys: ['onedrive'], name: 'OneDrive for Business' },
{ keys: ['office', 'word', 'excel', 'powerpoint', '365 apps'], name: 'Microsoft 365 Apps' },
{ keys: ['copilot'], name: 'Microsoft 365 Copilot' },
{ keys: ['intune', 'endpoint'], name: 'Microsoft Intune' },
{ keys: ['admin center', 'portal'], name: 'Microsoft 365 Admin Center' }
];
async function m365() {
return safe('m365', 'Microsoft 365', 'cloud.microsoft', async () => {
const now = Date.now();
const incidents = [];
try {
const entries = await parseRssUrls([
'cloud.microsoft',
'office365.com'
]);
for (const e of entries) {
const txt = (e.title + ' ' + e.desc).toLowerCase();
const hoursDiff = e.date ? (now - e.date.getTime()) / (1000 * 60 * 60) : 0;
if (txt.includes('resolved') || txt.includes('restored')) continue;
if (e.date && hoursDiff > 72) continue;
incidents.push({
name: clean(e.title, 120),
level: severity(txt),
detail: clean(e.desc)
});
}
} catch (_) {
const html = await httpGet('cloud.microsoft');
const low = html.toLowerCase();
if (low.includes('service interruption') || low.includes('active incident')) {
incidents.push({
name: 'Aviso activo publicado en status.cloud.microsoft',
level: LEVELS.DEGRADED,
detail: 'Consulta la página oficial de Microsoft 365 para ver los detalles del incidente.'
});
}
}
return {
id: 'm365',
name: 'Microsoft 365',
url: 'cloud.microsoft',
level: worst([LEVELS.OK, ...incidents.map(i => i.level)]),
incidents: incidents,
services: mapCoreServices(M365_CORE_SERVICES, incidents),
note: 'Estado público de servicios de Microsoft 365.',
error: null
};
});
}
app.get('/api/status', async (req, res) => {
const providers = await Promise.all([m365(), azure(), aws(), gcp(), cloudflare()]);
const updated = new Date().toLocaleTimeString('es-ES', { hour12: false });
res.json({ providers: providers, updated: updated });
});
app.listen(PORT, () => {
console.log('Servidor CloudStatus escuchando en el puerto ' + PORT);
});
