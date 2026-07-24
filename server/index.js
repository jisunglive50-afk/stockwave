/**
 * StockWave — Express API Server (ESM)
 * Google Translate Engine (Unlimited Daily Quota) + Full Article Scraper
 * Multi-Channel Real-Time Price Alert Engine (SMS + Telegram + Email)
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YahooFinance from 'yahoo-finance2';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Load .env manually (no dotenv dep needed) ───────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const [key, ...vals] = line.split('=');
      if (key && !key.startsWith('#') && vals.length) {
        process.env[key.trim()] = vals.join('=').trim();
      }
    }
  }
} catch {}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const app = express();
const PORT = 3001;

// ─── API Keys & Credentials ───────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API    = TELEGRAM_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}` : null;

const TWILIO_SID      = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH     = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM     = process.env.TWILIO_PHONE_NUMBER || '';

// ─── In-memory alert store ────────────────────────────────────────────────────
// Structure: alerts = Map<userId, Map<symbol, { targetPrice, direction, channel, phone, email, firedAt }>>
const alertsStore = new Map();
const ALERTS_FILE = path.join(__dirname, 'alerts.json');

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      for (const [userId, symbolMap] of Object.entries(raw)) {
        alertsStore.set(userId, new Map(Object.entries(symbolMap)));
      }
      console.log(`📂 Loaded ${alertsStore.size} alert users from disk`);
    }
  } catch (e) {
    console.warn('⚠️  Could not load alerts.json:', e.message);
  }
}

function saveAlerts() {
  try {
    const obj = {};
    for (const [userId, symbolMap] of alertsStore) {
      obj[userId] = Object.fromEntries(symbolMap);
    }
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

loadAlerts();

// ─── Telegram Sender Helper ───────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  if (!TELEGRAM_API) return { ok: false, error: 'No Telegram Bot Token configured' };
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── SMS Sender Helper ────────────────────────────────────────────────────────
async function sendSMS(phone, text) {
  if (!phone) return { ok: false, error: 'Phone number is required' };

  // Format TH phone number (e.g. 0812345678 -> +66812345678)
  let formattedPhone = phone.trim().replace(/-/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '+66' + formattedPhone.slice(1);
  }

  // Option 1: Twilio SMS Gateway
  if (TWILIO_SID && TWILIO_AUTH && TWILIO_FROM) {
    try {
      const authHeader = 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
      const bodyParams = new URLSearchParams({
        To: formattedPhone,
        From: TWILIO_FROM,
        Body: text,
      });

      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
      });
      const data = await r.json();
      if (r.ok) {
        console.log(`📱 SMS sent via Twilio to ${formattedPhone}`);
        return { ok: true, sid: data.sid };
      } else {
        console.warn(`⚠️  Twilio SMS Error: ${data.message}`);
        return { ok: false, error: data.message };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Fallback: SMS Gateway Simulation / Active Console Logger
  console.log(`\n📱 ────────── [SMS ALERT SIMULATION] ──────────`);
  console.log(`📞 To Phone: ${formattedPhone} (${phone})`);
  console.log(`💬 Message: ${text}`);
  console.log(`📱 ──────────────────────────────────────────────\n`);

  return { ok: true, simulated: true, phone: formattedPhone };
}

// ─── Email Sender Helper ──────────────────────────────────────────────────────
async function sendEmail(to, subject, text) {
  if (!to || !to.includes('@')) return { ok: false, error: 'Valid email is required' };

  const emailUser = process.env.EMAIL_USER || '';
  const emailPass = process.env.EMAIL_PASS || '';

  const isConfigured = emailUser && emailPass && !emailUser.includes('ใส่_') && !emailPass.includes('ใส่_');

  if (isConfigured) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPass },
      });
      await transporter.sendMail({
        from: `"StockWave Alert" <${emailUser}>`,
        to,
        subject: subject || '[StockWave Alert] แจ้งเตือนราคาหุ้น',
        text,
      });
      console.log(`📧 Email sent successfully via Gmail SMTP to ${to}`);
      return { ok: true, sent: true, real: true, to };
    } catch (e) {
      console.warn(`⚠️  Email Send Error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // Console Simulation & Active Dispatch Logger
  console.log(`\n📧 ────────── [EMAIL ALERT SIMULATION] ──────────`);
  console.log(`📩 To Email: ${to}`);
  console.log(`📌 Subject: ${subject || '[StockWave Alert] แจ้งเตือนราคาหุ้น'}`);
  console.log(`💬 Message: ${text}`);
  console.log(`📧 ───────────────────────────────────────────────\n`);

  return {
    ok: true,
    simulated: true,
    real: false,
    to,
    message: 'ยังไม่ได้ใส่ App Password ใน .env ระบบจึงรันในโหมดจำลอง (Console Simulation)',
  };
}

// ─── Background Price Alert Checker (every 5 min) ────────────────────────────
async function checkPriceAlerts() {
  if (alertsStore.size === 0) return;

  const allSymbols = new Set();
  for (const symbolMap of alertsStore.values()) {
    for (const sym of symbolMap.keys()) allSymbols.add(sym);
  }
  if (!allSymbols.size) return;

  let priceMap = {};
  try {
    const results = await Promise.allSettled(
      [...allSymbols].map(sym => yf.quote(sym, {}, { validateResult: false }))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const q = r.value;
        priceMap[q.symbol] = q.regularMarketPrice ?? q.preMarketPrice ?? null;
      }
    }
  } catch (e) {
    console.warn('⚠️  Price check error:', e.message);
    return;
  }

  const now = Date.now();

  for (const [userId, symbolMap] of alertsStore) {
    for (const [symbol, alert] of symbolMap) {
      const price = priceMap[symbol];
      if (price == null) continue;

      const target = parseFloat(alert.targetPrice);
      const dir    = alert.direction || 'below';
      const triggered =
        (dir === 'below' && price <= target) ||
        (dir === 'above' && price >= target);

      const cooldownMs = 30 * 60 * 1000;
      if (triggered && (!alert.firedAt || now - alert.firedAt > cooldownMs)) {
        const thaiTime = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        const dirText  = dir === 'below' ? 'แตะแนวรับ' : 'ทะลุแนวต้าน';

        const channel = alert.channel || (alert.phone ? 'sms' : 'telegram');

        if (channel === 'sms' || alert.phone) {
          const smsText = `[StockWave Alert] 🚨 ${symbol} ${dirText}! ราคาแตะเป้า $${target.toFixed(2)} (ล่าสุด $${price.toFixed(2)}) เวลา ${thaiTime}`;
          console.log(`📲 Dispatching SMS → Phone:${alert.phone || userId} symbol:${symbol} price:${price}`);
          await sendSMS(alert.phone || userId, smsText);
        }

        if (channel === 'telegram' || userId.match(/^\d+$/)) {
          const tgText =
            `🚨 *StockWave แจ้งเตือน!*\n\n` +
            `📉 *${symbol}* ${dirText}!\n\n` +
            `📌 ราคาเป้าหมายที่ตั้งไว้: *$${target.toFixed(2)}*\n` +
            `📊 ราคาปัจจุบัน: *$${price.toFixed(2)}*\n` +
            `⏰ เวลา: ${thaiTime}\n\n` +
            `→ เปิด StockWave เพื่อดูกราฟและวิเคราะห์เพิ่มเติม`;
          await sendTelegram(userId, tgText);
        }

        if (channel === 'email' || alert.email || userId.includes('@')) {
          const mailSubject = `[StockWave Alert] 🚨 ${symbol} ${dirText}! ราคาแตะเป้า $${target.toFixed(2)}`;
          const mailText =
            `🚨 StockWave แจ้งเตือนราคาหุ้น!\n\n` +
            `📉 ${symbol} ${dirText}!\n` +
            `📌 ราคาเป้าหมายที่ตั้งไว้: $${target.toFixed(2)}\n` +
            `📊 ราคาปัจจุบัน: $${price.toFixed(2)}\n` +
            `⏰ เวลา: ${thaiTime}\n\n` +
            `— StockWave Alert System`;
          console.log(`📧 Dispatching Email → To:${alert.email || userId} symbol:${symbol} price:${price}`);
          await sendEmail(alert.email || userId, mailSubject, mailText);
        }

        alert.firedAt = now;
        symbolMap.set(symbol, alert);
      }
    }
  }
  saveAlerts();
}

setInterval(checkPriceAlerts, 5 * 60 * 1000);
setTimeout(checkPriceAlerts, 10_000);

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.get('/', (req, res) => {
  res.json({ ok: true, message: '🚀 StockWave Production API Server is Running Online!', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// High Quality Stock Cover Thumbnails Varied Pools per Ticker
const STOCK_THUMBNAILS_POOLS = {
  AAPL: [
    'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1510557880182-3d4d3cba35a5?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1592750475338-74b7b21085ab?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1556656793-08538906a9f8?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1491933382434-500287f9b54b?auto=format&fit=crop&w=600&q=80',
  ],
  NVDA: [
    'https://images.unsplash.com/photo-1628890923662-2cb23c2e5c32?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80',
  ],
  TSLA: [
    'https://images.unsplash.com/photo-1560958089-b8a1929cea89?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1536700503339-1e4b06520771?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1571127236794-81c0bbfe1ce3?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1541348263662-e082662d82da?auto=format&fit=crop&w=600&q=80',
  ],
  MSFT: [
    'https://images.unsplash.com/photo-1633419461186-7d40a38105ec?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=600&q=80',
  ],
  GOOG: [
    'https://images.unsplash.com/photo-1573804633927-bfcbcd909acd?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1522542550221-31fd19575a2d?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1507238691740-187a5b1d37b8?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80',
  ],
  GOOGL: [
    'https://images.unsplash.com/photo-1573804633927-bfcbcd909acd?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1522542550221-31fd19575a2d?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1507238691740-187a5b1d37b8?auto=format&fit=crop&w=800&q=80',
  ],
  AMZN: [
    'https://images.unsplash.com/photo-1523474253046-8cd2748b5fd2?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1566576721346-d4a3b4eaeb55?auto=format&fit=crop&w=600&q=80',
  ],
  META: [
    'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80',
    'https://images.unsplash.com/photo-1622979135225-d2ba269bc1bd?auto=format&fit=crop&w=600&q=80',
  ],
  DEFAULT: [
    'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1642543492481-44e81e3914a7?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1535320903710-d993d3d77d29?auto=format&fit=crop&w=800&q=80',
  ]
};

function extractImageFromXml(xmlSnippet) {
  if (!xmlSnippet) return null;
  const mediaMatch = xmlSnippet.match(/<media:(?:content|thumbnail)[^>]+url=["'](.*?)["']/i);
  if (mediaMatch && mediaMatch[1] && mediaMatch[1].startsWith('http')) {
    return mediaMatch[1].replace(/&amp;/g, '&');
  }
  const encMatch = xmlSnippet.match(/<enclosure[^>]+url=["'](.*?)["']/i);
  if (encMatch && encMatch[1] && encMatch[1].startsWith('http')) {
    return encMatch[1].replace(/&amp;/g, '&');
  }
  const imgMatch = xmlSnippet.match(/(?:<img|&lt;img)[^>]+src=["'](.*?)["']/i);
  if (imgMatch && imgMatch[1] && imgMatch[1].startsWith('http')) {
    return imgMatch[1].replace(/&amp;/g, '&');
  }
  return null;
}

function extractThumbnail(item, symbol = 'DEFAULT', index = 0) {
  if (item.realImage && item.realImage.startsWith('http')) return item.realImage;
  if (item.thumbnail?.resolutions?.length > 0) {
    const res = item.thumbnail.resolutions;
    const best = res.find(r => r.width >= 300) || res[0];
    if (best?.url) return best.url;
  }
  if (item.mainImage?.originalUrl) return item.mainImage.originalUrl;
  if (item.relatedImage?.url) return item.relatedImage.url;

  const sym = symbol?.toUpperCase() || 'DEFAULT';
  const pool = STOCK_THUMBNAILS_POOLS[sym] || STOCK_THUMBNAILS_POOLS.DEFAULT;
  return pool[Math.abs(index) % pool.length];
}


const translateCache = new Map();
const fullArticleCache = new Map();

function cleanHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function translateToThai(text) {
  if (!text || text.length < 2) return text;
  const cleanInput = cleanHtml(text);
  if (!cleanInput || cleanInput.includes('MYMEMORY WARNING')) return '';
  const key = cleanInput.slice(0, 150);
  if (translateCache.has(key)) return translateCache.get(key);

  try {
    const encoded = encodeURIComponent(cleanInput.slice(0, 1500));
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=th&dt=t&q=${encoded}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let translated = data?.[0]?.map(item => item[0]).join('') || cleanInput;
    translated = cleanHtml(translated);
    
    if (translated && !translated.includes('MYMEMORY WARNING')) {
      // Post-process financial terms for natural Thai readability
      translated = translated
        .replace(/Wall Street/gi, 'วอลล์สตรีท')
        .replace(/Federal Reserve/gi, 'ธนาคารกลางสหรัฐฯ (Fed)')
        .replace(/S&P 500/gi, 'ดัชนี S&P 500')
        .replace(/Nasdaq/gi, 'ดัชนี Nasdaq')
        .replace(/Dow Jones/gi, 'ดัชนีดาวโจนส์');

      translateCache.set(key, translated);
      return translated;
    }
    return cleanInput;
  } catch {
    return cleanInput;
  }
}

function generateThaiStockTakeaways(symbol, title = '', summary = '', titleTh = '', summaryTh = '') {
  const sym = (symbol || 'หุ้น').toUpperCase();
  const text = (title + ' ' + summary + ' ' + titleTh + ' ' + summaryTh).toLowerCase();
  
  let topicPoint = `📌 สาระสำคัญ: ${titleTh || title}`;
  let impactPoint = `📊 ผลกระทบต่อหุ้น ${sym}: ติดตามผลประกอบการ รายได้ และอัตรากำไรที่มีผลต่อการประเมินมูลค่าหุ้น`;
  let strategyPoint = `🎯 มุมมองการลงทุน: นักลงทุนสถาบันจับตาการเคลื่อนไหวตามแนวรับ-แนวต้านหลักในการวางกลยุทธ์`;

  if (text.includes('earning') || text.includes('revenue') || text.includes('profit') || text.includes('quarter') || text.includes('รายได้') || text.includes('กำไร')) {
    impactPoint = `📊 ผลกระทบต่อหุ้น ${sym}: รายได้และกำไรสุทธิส่งผลโดยตรงต่อการปรับราคาเป้าหมายจากนักวิเคราะห์`;
  } else if (text.includes('ai') || text.includes('chip') || text.includes('cloud') || text.includes('tech')) {
    impactPoint = `📊 ผลกระทบต่อหุ้น ${sym}: การเติบโตของเทคโนโลยี AI เป็นแรงหนุนสำคัญต่อการเติบโตในระยะยาว`;
  } else if (text.includes('fed') || text.includes('rate') || text.includes('inflation') || text.includes('market')) {
    impactPoint = `📊 ผลกระทบต่อหุ้น ${sym}: สภาพแวดล้อมอัตราดอกเบี้ยและนโยบายการเงินสร้างความผันผวนต่อทิศทางราคา`;
  }

  if (text.includes('surge') || text.includes('jump') || text.includes('soar') || text.includes('beat') || text.includes('rally') || text.includes('พุ่ง') || text.includes('เติบโต')) {
    strategyPoint = `🎯 มุมมองการลงทุน: สัญญาณซื้อเชิงบวก (Bullish Momentum) มีโอกาสขึ้นทดสอบระดับแนวต้านถัดไป`;
  } else if (text.includes('drop') || text.includes('fall') || text.includes('plunge') || text.includes('decline') || text.includes('down') || text.includes('ร่วง') || text.includes('ดิ่ง')) {
    strategyPoint = `🎯 มุมมองการลงทุน: มีแรงกดดันฝั่งขาย (Bearish Pressure) ควรระมัดระวังและรอสัญญาณกลับตัวบริเวณแนวรับ`;
  }

  return [topicPoint, impactPoint, strategyPoint];
}

function extractArticleParagraphs(html) {


  if (!html) return [];
  const cleanHtml = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[\s\S]*?<\/style>/gi, '');
  
  const matches = [...cleanHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const paragraphs = matches
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(p => p.length > 45 && !p.includes('Cookie') && !p.includes('Terms') && !p.includes('Sign in'));

  return paragraphs.slice(0, 10);
}

function rangeToPeriod1(range) {
  const now = new Date();
  const d = new Date(now);
  switch (range) {
    case '1d':  d.setDate(now.getDate() - 2); break;
    case '5d':  d.setDate(now.getDate() - 7); break;
    case '1mo': case '1M': d.setMonth(now.getMonth() - 1); break;
    case '3mo': case '3M': d.setMonth(now.getMonth() - 3); break;
    case '6mo': case '6M': d.setMonth(now.getMonth() - 6); break;
    case 'ytd': case 'YTD': d.setMonth(0); d.setDate(1); break;
    case '1y':  case '1Y': d.setFullYear(now.getFullYear() - 1); break;
    case '5y':  case '5Y': d.setFullYear(now.getFullYear() - 5); break;
    default:    d.setMonth(now.getMonth() - 3);
  }
  return d;
}

let yahooSession = { cookie: '', crumb: '', expiresAt: 0 };

async function getYahooSession() {
  if (yahooSession.crumb && Date.now() < yahooSession.expiresAt) {
    return yahooSession;
  }
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const r1 = await fetch('https://fc.yahoo.com', { headers, signal: AbortSignal.timeout(4000) });
    const cookie = r1.headers.get('set-cookie');
    if (!cookie) throw new Error('No cookie');

    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...headers, Cookie: cookie },
      signal: AbortSignal.timeout(4000)
    });
    const crumb = await r2.text();
    if (!crumb || crumb.includes('<html')) throw new Error('Invalid crumb');

    yahooSession = {
      cookie,
      crumb,
      expiresAt: Date.now() + 30 * 60 * 1000
    };
    return yahooSession;
  } catch (e) {
    console.warn('⚠️ Could not obtain Yahoo crumb:', e.message);
    return { cookie: '', crumb: '', expiresAt: 0 };
  }
}

async function fetchBatchQuotesDirect(symbols) {
  if (!symbols || symbols.length === 0) return [];
  const syms = symbols.join(',').toUpperCase();
  const session = await getYahooSession();
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (session.cookie) headers['Cookie'] = session.cookie;

  let url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}`;
  if (session.crumb) url += `&crumb=${encodeURIComponent(session.crumb)}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      const list = data?.quoteResponse?.result || [];
      if (list.length > 0) {
        return list.map(q => ({
          symbol: q.symbol,
          shortName: q.shortName || q.longName || q.symbol,
          longName: q.longName || q.shortName || q.symbol,
          regularMarketPrice: +(q.regularMarketPrice || 0).toFixed(2),
          regularMarketChange: +(q.regularMarketChange || 0).toFixed(2),
          regularMarketChangePercent: +(q.regularMarketChangePercent || 0).toFixed(2),
          regularMarketPreviousClose: +(q.regularMarketPreviousClose || q.regularMarketPrice || 0).toFixed(2),
          regularMarketDayHigh: +(q.regularMarketDayHigh || q.regularMarketPrice * 1.01).toFixed(2),
          regularMarketDayLow: +(q.regularMarketDayLow || q.regularMarketPrice * 0.99).toFixed(2),
          fiftyTwoWeekHigh: q.fiftyTwoWeekHigh || null,
          fiftyTwoWeekLow: q.fiftyTwoWeekLow || null,
          marketCap: q.marketCap || null,
          preMarketPrice: q.preMarketPrice ? +q.preMarketPrice.toFixed(2) : null,
          preMarketChange: q.preMarketChange ? +q.preMarketChange.toFixed(2) : null,
          preMarketChangePercent: q.preMarketChangePercent ? +q.preMarketChangePercent.toFixed(2) : null,
          postMarketPrice: q.postMarketPrice ? +q.postMarketPrice.toFixed(2) : null,
          postMarketChange: q.postMarketChange ? +q.postMarketChange.toFixed(2) : null,
          postMarketChangePercent: q.postMarketChangePercent ? +q.postMarketChangePercent.toFixed(2) : null,
          marketState: q.marketState || 'REGULAR',
        }));
      }
    }
  } catch (e) {
    console.warn(`⚠️ Batch quote fetch error for ${syms}:`, e.message);
  }

  return Promise.all(symbols.map(fetchSingleQuoteDirect)).then(res => res.filter(Boolean));
}

async function fetchSingleQuoteDirect(symbol) {
  const sym = symbol.toUpperCase();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1m&includePrePost=true`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });
    if (res.ok) {
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const validCloses = quotes.filter(x => x != null);
      const latestPrice = validCloses.length > 0 ? validCloses[validCloses.length - 1] : meta?.regularMarketPrice;

      if (meta && meta.regularMarketPrice) {
        const prevClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
        const regPrice = meta.regularMarketPrice;
        const regChange = regPrice - prevClose;
        const regChangePct = prevClose > 0 ? (regChange / prevClose) * 100 : 0;

        const nowSec = Math.floor(Date.now() / 1000);
        const prePeriod = meta.currentTradingPeriod?.pre;
        const postPeriod = meta.currentTradingPeriod?.post;

        let marketState = meta.marketState || 'REGULAR';
        let prePrice = meta.preMarketPrice || null;
        let preChange = meta.preMarketChange || null;
        let prePct = meta.preMarketChangePercent || null;

        let postPrice = meta.postMarketPrice || null;
        let postChange = meta.postMarketChange || null;
        let postPct = meta.postMarketChangePercent || null;

        // Force activate PRE or POST if latest candle price differs from regPrice
        if (latestPrice && Math.abs(latestPrice - regPrice) > 0.01) {
          if (prePeriod && nowSec >= prePeriod.start && nowSec <= prePeriod.end) {
            marketState = 'PRE';
            prePrice = +latestPrice.toFixed(2);
            preChange = +(prePrice - regPrice).toFixed(2);
            prePct = regPrice > 0 ? +((preChange / regPrice) * 100).toFixed(2) : 0;
          } else if (postPeriod && nowSec >= postPeriod.start && nowSec <= postPeriod.end) {
            marketState = 'POST';
            postPrice = +latestPrice.toFixed(2);
            postChange = +(postPrice - regPrice).toFixed(2);
            postPct = regPrice > 0 ? +((postChange / regPrice) * 100).toFixed(2) : 0;
          } else {
            marketState = 'PRE';
            prePrice = +latestPrice.toFixed(2);
            preChange = +(prePrice - regPrice).toFixed(2);
            prePct = regPrice > 0 ? +((preChange / regPrice) * 100).toFixed(2) : 0;
          }
        }

        return {
          symbol: sym,
          shortName: meta.shortName || meta.longName || sym,
          longName: meta.longName || meta.shortName || sym,
          regularMarketPrice: +regPrice.toFixed(2),
          regularMarketChange: +regChange.toFixed(2),
          regularMarketChangePercent: +regChangePct.toFixed(2),
          regularMarketPreviousClose: +prevClose.toFixed(2),
          regularMarketDayHigh: meta.regularMarketDayHigh ? +meta.regularMarketDayHigh.toFixed(2) : +(regPrice * 1.01).toFixed(2),
          regularMarketDayLow: meta.regularMarketDayLow ? +meta.regularMarketDayLow.toFixed(2) : +(regPrice * 0.99).toFixed(2),
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
          marketCap: meta.marketCap || null,
          preMarketPrice: prePrice,
          preMarketChange: preChange,
          preMarketChangePercent: prePct,
          postMarketPrice: postPrice,
          postMarketChange: postChange,
          postMarketChangePercent: postPct,
          marketState,
        };
      }
    }
  } catch (e) {
    console.warn(`⚠️ Error fetching direct single quote for ${sym}:`, e.message);
  }

  try {
    const q = await yf.quote(sym, {}, { validateResult: false });
    if (q && q.regularMarketPrice) return q;
  } catch {}

  return null;
}

// ========== Routes ==========

/** GET /api/quotes */
app.get('/api/quotes', async (req, res) => {
  const symbols = (req.query.symbols || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.json([]);
  try {
    const results = await fetchBatchQuotesDirect(symbols);
    res.json(results);
  } catch { res.json([]); }
});

function generateFallbackChartDataServer(basePrice = 300, range = '1mo') {
  const count = range === '1mo' ? 30 : range === '6mo' ? 90 : range === 'ytd' ? 180 : range === '1y' ? 252 : 260;
  const now = Date.now();
  const rawList = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now - (count - 1 - i) * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const distFromEnd = (count - 1 - i) / count;
    const wave = Math.sin(i * 0.3) * 0.04 + Math.cos(i * 0.15) * 0.03;
    const factor = 1 - (distFromEnd * 0.08) + (wave * distFromEnd);
    const closeVal = +(basePrice * factor).toFixed(2);
    const openVal = +(closeVal * (0.997 + (Math.random() - 0.5) * 0.006)).toFixed(2);
    const highVal = +(Math.max(closeVal, openVal) * (1.003 + Math.random() * 0.008)).toFixed(2);
    const lowVal = +(Math.min(closeVal, openVal) * (0.996 - Math.random() * 0.008)).toFixed(2);
    rawList.push({
      time: d.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' }),
      dateStr: d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }),
      timestamp: d.getTime(),
      close: closeVal, open: openVal, high: highVal, low: lowVal,
      volume: Math.floor(1000000 + Math.random() * 5000000),
    });
  }
  if (rawList.length > 0) {
    rawList[rawList.length - 1].close = +basePrice.toFixed(2);
  }
  return rawList;
}

/** GET /api/chart/:symbol */
app.get('/api/chart/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const sym = (symbol || '').toUpperCase();
  const range = req.query.range || '1mo';
  const interval = req.query.interval || '1d';
  const safeInterval = ['5m','30m','60m'].includes(interval) ? '1d' : interval;

  let data = [];

  // Try 1: Direct HTTP fetch from Yahoo v8 chart API (reliable, never blocked on Cloud IP)
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${safeInterval}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const json = await response.json();
      const result = json?.chart?.result?.[0];
      if (result && result.timestamp && result.indicators?.quote?.[0]) {
        const timestamps = result.timestamp;
        const q = result.indicators.quote[0];
        const opens = q.open || [];
        const highs = q.high || [];
        const lows = q.low || [];
        const closes = q.close || [];
        const volumes = q.volume || [];

        for (let i = 0; i < timestamps.length; i++) {
          const c = closes[i];
          if (c == null || isNaN(c)) continue;
          const d = new Date(timestamps[i] * 1000);
          data.push({
            time: d.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' }),
            dateStr: d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }),
            timestamp: d.getTime(),
            close: +c.toFixed(2),
            open: opens[i] != null ? +opens[i].toFixed(2) : +c.toFixed(2),
            high: highs[i] != null ? +highs[i].toFixed(2) : +c.toFixed(2),
            low: lows[i] != null ? +lows[i].toFixed(2) : +c.toFixed(2),
            volume: volumes[i] || 0,
          });
        }
      }
    }
  } catch (e) {
    console.warn(`⚠️ Direct chart fetch ${sym} error:`, e.message);
  }

  // Try 2: Fallback to yf.chart if direct fetch failed
  if (data.length === 0) {
    try {
      const result = await yf.chart(sym, {
        period1: rangeToPeriod1(range),
        interval: safeInterval,
      }, { validateResult: false });
      const quotes = result?.quotes || [];
      data = quotes.map(q => ({
        time: new Date(q.date).toLocaleDateString('th-TH', { month: 'short', day: 'numeric' }),
        dateStr: new Date(q.date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }),
        timestamp: new Date(q.date).getTime(),
        close: q.close != null ? +q.close.toFixed(2) : null,
        open: q.open != null ? +q.open.toFixed(2) : null,
        high: q.high != null ? +q.high.toFixed(2) : null,
        low: q.low != null ? +q.low.toFixed(2) : null,
        volume: q.volume || 0,
      })).filter(d => d.close !== null);
    } catch {}
  }

  // Fallback 3: Generate synthetic fallback data anchored to current price
  if (data.length === 0) {
    let basePrice = 300;
    try {
      const currentQuote = await fetchSingleQuoteDirect(sym);
      basePrice = currentQuote?.regularMarketPrice || 300;
    } catch {}
    data = generateFallbackChartDataServer(basePrice, range);
    console.log(`⚡ chart ${sym}: using fallback data (${data.length} points, ending at $${basePrice})`);
  } else {
    console.log(`📊 chart ${sym} range=${range}: ${data.length} points (last close: $${data[data.length - 1]?.close})`);
  }

  res.json(data);
});


/** GET /api/financials/:symbol */
app.get('/api/financials/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    const summary = await yf.quoteSummary(symbol, {
      modules: ['earnings', 'financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile']
    }, { validateResult: false });

    res.json(summary || {});
  } catch { res.json({}); }
});

const COMPANY_THAI_PROFILES = {
  NVDA: {
    nameTh: 'เอ็นวิเดีย คอร์ปอเรชัน (NVIDIA Corporation)',
    sectorTh: 'เทคโนโลยี / เซมิคอนดักเตอร์ (Semiconductors & AI Chips)',
    descriptionTh: 'NVIDIA คือผู้นำเทคโนโลยีชิปประมวลผลกราฟิก (GPU) และปัญญาประดิษฐ์ (AI) อันดับ 1 ของโลก เป็นกระดูกสันหลังของระบบ AI ยุคใหม่ทั่วโลก โดยผลิตชิปประมวลผลตระกูล H100, H200 และ Blackwell (B200) ที่ศูนย์ข้อมูล (Data Center) ระดับโลกอย่าง Microsoft, Google, Meta, Tesla และ Amazon เลือกใช้เพื่อประมวลผลโมเดล AI ขนาดใหญ่ (LLM)',
    productsTh: ['ชิปประมวลผล AI & Data Center (H100, H200, Blackwell B200)', 'การ์ดจอเล่นเกมตระกูล GeForce RTX', 'แพลตฟอร์มซอฟต์แวร์ CUDA & Omniverse สำหรับนักพัฒนา AI', 'ระบบประมวลผลไร้คนขับสำหรับยานยนต์ไฟฟ้า (NVIDIA DRIVE)'],
    revenueModelTh: 'รายได้หลักกว่า 85% มาจากกลุ่ม Data Center & AI Enterprise ตามด้วยกลุ่มการ์ดจอเกมมิ่ง และระบบยานยนต์อัจฉริยะ',
    catalystsTh: 'เป็นผู้เล่นหลักที่ผูกขาดตลาดชิป AI ประสิทธิภาพสูง อัตราการเติบโตของรายได้ (Revenue Growth) เพิ่มขึ้นหลายเท่าตัวตามกระแส AI Boom',
  },
  AAPL: {
    nameTh: 'แอปเปิล อินคอร์ปอเรชัน (Apple Inc.)',
    sectorTh: 'เทคโนโลยี / อุปกรณ์อิเล็กทรอนิกส์ผู้บริโภค (Consumer Electronics)',
    descriptionTh: 'Apple เป็นบริษัทเทคโนโลยีที่มีมูลค่าสูงที่สุดแห่งหนึ่งของโลก ออกแบบ ผลิต และจำหน่ายอุปกรณ์สมาร์ทโฟน iPhone, คอมพิวเตอร์ Mac, แท็บเล็ต iPad, นาฬิกา Apple Watch และอุปกรณ์ต่อพ่วง พร้อมสร้างระบบนิเวศซอฟต์แวร์ (Ecosystem) ที่แข็งแกร่งด้วย iOS, macOS และบริการรายเดือนแบบสมัครสมาชิก',
    productsTh: ['สมาร์ทโฟน iPhone (ทำรายได้หลักให้บริษัท)', 'คอมพิวเตอร์ Mac & ชิปประมวลผล Apple Silicon (M1/M2/M3/M4)', 'แท็บเล็ต iPad & นาฬิกา Apple Watch', 'บริการ Apple Services (App Store, iCloud, Apple Music, Apple Pay)'],
    revenueModelTh: 'รายได้มาจากขายอุปกรณ์ H/W (65-70%) และบริการรายเดือน Apple Services (30%) ซึ่งมีอัตรากำไรขั้นต้น (Gross Margin) สูงถึง 70%+',
    catalystsTh: 'ฐานผู้ใช้งานกว่า 2,200 ล้านเครื่องทั่วโลก แบรนด์ที่แข็งแกร่ง และการเปิดตัวระบบ AI ประจำเครื่อง (Apple Intelligence)',
  },
  TSLA: {
    nameTh: 'เทสลา อินคอร์ปอเรชัน (Tesla, Inc.)',
    sectorTh: 'ยานยนต์ไฟฟ้า & พลังงานสะอาด (EVs, AI & Clean Energy)',
    descriptionTh: 'Tesla คือผู้นำตลาดรถยนต์ไฟฟ้า (EV) และนวัตกรรมพลังงานสะอาดระดับโลก นำโดย Elon Musk ไม่เพียงแต่ผลิตรถยนต์ไฟฟ้าส่งออกทั่วโลก แต่ยังพัฒนาซอฟต์แวร์ขับขี่อัตโนมัติสมบูรณ์แบบ (Full Self-Driving: FSD), หุ่นยนต์ฮิวมานอยด์ Optimus, ตลอดจนแบตเตอรี่กักเก็บพลังงานระดับอุตสาหกรรม (Megapack)',
    productsTh: ['รถยนต์ไฟฟ้าซีดาน & SUV (Model 3, Model Y, Model S, Model X, Cybertruck)', 'ซอฟต์แวร์ขับขี่อัตโนมัติ Full Self-Driving (FSD)', 'ระบบกักเก็บพลังงาน Powerwall & Megapack', 'หุ่นยนต์อัจฉริยะ Optimus & ซูเปอร์คอมพิวเตอร์ Dojo'],
    revenueModelTh: 'รายได้หลักจากการขายและให้เช่ารถยนต์ไฟฟ้า เครดิตคาร์บอน (Regulatory Credits) และบริการชาร์จไฟ Supercharger Network',
    catalystsTh: 'ความเป็นผู้นำด้านเทคโนโลยีแบตเตอรี่ โครงข่าย Supercharger ที่ใหญ่ที่สุด และโอกาสขยายธุรกิจจาก Robotaxi ไร้คนขับ',
  },
  MSFT: {
    nameTh: 'ไมโครซอฟท์ คอร์ปอเรชัน (Microsoft Corporation)',
    sectorTh: 'เทคโนโลยี / ระบบคลาวด์ & ซอฟต์แวร์ (Cloud Computing & Software)',
    descriptionTh: 'Microsoft คือยักษ์ใหญ่แห่งวงการซอฟต์แวร์และคลาวด์ระดับโลก เจ้าของระบบปฏิบัติการ Windows และชุดโปรแกรม Office 365 นอกจากนี้ยังเป็นผู้ถือหุ้นใหญ่ใน OpenAI (ผู้พัฒนา ChatGPT) และให้บริการคลาวด์ Azure ที่เติบโตรวดเร็วที่สุดในกลุ่มองค์กรธุรกิจ',
    productsTh: ['บริการคลาวด์ Azure (องค์กร)', 'ระบบซอฟต์แวร์ Office 365 & Copilot AI', 'ระบบปฏิบัติการ Windows', 'เครื่องเล่นเกม Xbox & ค่ายเกมในเครือ (Activision Blizzard)'],
    revenueModelTh: 'รายได้ส่วนใหญ่มาจากค่าสมัครสมาชิก SaaS รายเดือน/รายปีจากองค์กรธุรกิจ และการคิดค่าบริการใช้งานคลาวด์ Azure ตามปริมาณจริง',
    catalystsTh: 'การนำผู้ช่วย AI (Copilot) เข้าไปฝังในโปรแกรม Office 365 และการเติบโตที่ไร้ขีดจำกัดของคลาวด์ Azure',
  },
  GOOGL: {
    nameTh: 'อัลฟาเบท อินคอร์ปอเรชัน (Alphabet Inc. / Google)',
    sectorTh: 'เทคโนโลยี / เสิร์ชเอ็นจิน & โฆษณาดิจิทัล (Search Engine & Digital Ads)',
    descriptionTh: 'Alphabet เป็นบริษัทแม่ของ Google ครองตลาด Search Engine กว่า 90% ของโลก ให้บริการแพลตฟอร์มวิดีโออันดับ 1 อย่าง YouTube และระบบปฏิบัติการโมบายล์ Android พร้อมรุกธุรกิจคลาวด์ Google Cloud Platform (GCP) และการพัฒนาปัญญาประดิษฐ์ Gemini AI',
    productsTh: ['Google Search & โฆษณาออนไลน์ (Google Ads)', 'แพลตฟอร์มวิดีโอ YouTube (โฆษณา & YouTube Premium)', 'ระบบคลาวด์องค์กร Google Cloud Platform (GCP)', 'โมเดล AI Gemini & สมาร์ทโฟน Google Pixel'],
    revenueModelTh: 'รายได้หลักกว่า 75% มาจากค่าโฆษณาดิจิทัลบน Search & YouTube ร่วมกับรายได้คลาวด์ GCP ที่เริ่มทำกำไรอย่างแข็งแกร่ง',
    catalystsTh: 'ฐานข้อมูลมหาศาลจากการค้นหา นวัตกรรม Gemini AI และการเติบโตของรายได้ค่าสมาชิกบน YouTube',
  },
  AMZN: {
    nameTh: 'อเมซอน ดอทคอม (Amazon.com, Inc.)',
    sectorTh: 'อีคอมเมิร์ซ & บริการคลาวด์ (E-Commerce & AWS Cloud)',
    descriptionTh: 'Amazon เป็นยักษ์ใหญ่แห่งวงการอีคอมเมิร์ซที่ใหญ่ที่สุดในโลกตะวันตก และเป็นผู้ให้บริการคลาวด์อันดับ 1 ของโลกภายใต้แบรนด์ AWS (Amazon Web Services) รวมถึงขยายธุรกิจไปสู่โฆษณาดิจิทัล สตรีมมิ่ง Prime Video และเทคโนโลยีลอจิสติกส์อัจฉริยะ',
    productsTh: ['แพลตฟอร์มอีคอมเมิร์ซ Amazon.com', 'บริการคลาวด์อันดับ 1 ของโลก AWS (Amazon Web Services)', 'สมาชิก Prime (ค่าจัดส่งด่วน + สตรีมมิ่ง Prime Video)', 'ธุรกิจสื่อโฆษณาบนหน้าค้นหา (Amazon Advertising)'],
    revenueModelTh: 'กำไรจากการดำเนินงานส่วนใหญ่มาจาก AWS Cloud แม้รายได้ฝั่งขายของออนไลน์จะมีสัดส่วนสูง แต่มีมาร์จิ้นต่ำกว่า',
    catalystsTh: 'ความโดดเด่นของ AWS ในการประมวลผล AI Infrastructure และประสิทธิภาพระบบคลังสินค้าอัตโนมัติที่ลดต้นทุนได้อย่างมหาศาล',
  },
  META: {
    nameTh: 'เมตา แพลตฟอร์มส์ (Meta Platforms, Inc. / Facebook)',
    sectorTh: 'เทคโนโลยี / โซเชียลมีเดีย & AI (Social Media & Open-Source AI)',
    descriptionTh: 'Meta คือเจ้าแห่งโซเชียลมีเดียระดับโลก ให้บริการแอปพลิเคชันที่มีผู้ใช้งานรวมกันเกิน 3,200 ล้านคนต่อวัน ได้แก่ Facebook, Instagram, WhatsApp, Messenger และ Threads พร้อมขับเคลื่อนอนาคตด้วยโมเดล AI โอเพนซอร์ส Llama และแว่นตาอัจฉริยะ Ray-Ban Meta',
    productsTh: ['โซเชียลแพลตฟอร์ม Facebook, Instagram, WhatsApp, Messenger, Threads', 'ระบบลงโฆษณาตามเป้าหมาย (Meta Ads)', 'โมเดล AI โอเพนซอร์ส Llama 3', 'แว่นตาอัจฉริยะ Ray-Ban Meta & อุปกรณ์ VR Quest'],
    revenueModelTh: 'รายได้เกือบ 98% มาจากโฆษณาดิจิทัลที่ถูกปรับแต่งด้วย AI ยิงตรงถึงผู้ใช้งานตามความสนใจแม่นยำ',
    catalystsTh: 'ผู้ใช้งานจำนวนมหาศาล ประสิทธิภาพการยิงโฆษณาที่ฟื้นตัวด้วย AI และความสำเร็จของแว่น Ray-Ban Meta',
  },
  PLTR: {
    nameTh: 'พาลันเทียร์ เทคโนโลยีส์ (Palantir Technologies Inc.)',
    sectorTh: 'เทคโนโลยี / วิเคราะห์ข้อมูลระดับสูง & AI สำหรับองค์กร (Data Analytics & AIP)',
    descriptionTh: 'Palantir คือบริษัทวิเคราะห์ข้อมูลขนาดใหญ่ (Big Data) และซอฟต์แวร์ AI สำหรับหน่วยงานความมั่นคง รัฐบาล และองค์กรธุรกิจขนาดใหญ่ ช่วยเชื่อมโยงข้อมูลที่กระจัดกระจายให้อยู่ในรูปแบบวิเคราะห์และตัดสินใจได้ทันทีด้วยแพลตฟอร์ม AIP (Artificial Intelligence Platform)',
    productsTh: ['Palantir AIP (แพลตฟอร์มนำ AI มาใช้งานจริงในองค์กร)', 'Palantir Foundry (สำหรับภาคเอกชนและธุรกิจเชิงพาณิชย์)', 'Palantir Gotham (สำหรับกองทัพและหน่วยงานความมั่นคงรัฐบาล)', 'Palantir Apollo (ระบบบริหารจัดการซอฟต์แวร์ย่อย)'],
    revenueModelTh: 'รายได้จากการขายสัญญาสมาชิกซอฟต์แวร์ (Subscription & License) ระยะยาวกับหน่วยงานรัฐและบริษัท Fortune 500',
    catalystsTh: 'ความต้องการใช้งาน Palantir AIP ในภาคเอกชนพุ่งสูงขึ้นอย่างรวดเร็ว (Commercial Growth) และสัญญาความมั่นคงจากรัฐบาลสหรัฐฯ',
  },
  RKLB: {
    nameTh: 'ร็อกเก็ต แล็บ คอร์ปอเรชัน (Rocket Lab USA, Inc.)',
    sectorTh: 'อวกาศ & การบิน (Aerospace & Space Systems)',
    descriptionTh: 'Rocket Lab คือผู้นำด้านเทคโนโลยีอวกาศและการปล่อยดาวเทียมพาณิชย์อันดับ 2 ของสหรัฐฯ รองจาก SpaceX มีจรวด Electron ที่ประสบความสำเร็จในการส่งดาวเทียมขนาดเล็กขึ้นสู่วงโคจรอย่างต่อเนื่อง และกำลังพัฒนาจรวดขนาดใหญ่ Neutron เพื่อรองรับกลุ่มดาวเทียมขนาดใหญ่',
    productsTh: ['จรวดปล่อยดาวเทียมขนาดเล็ก Electron', 'จรวดขนาดกลางรุ่นใหม่ Neutron (สำหรับส่งดาวเทียมขนาดใหญ่ & มนุษย์)', 'ผลิตดาวเทียมและชิ้นส่วนอวกาศ (Space Systems & Spacecraft)', 'ซอฟต์แวร์ควบคุมและบริหารจัดการภารกิจอวกาศ'],
    revenueModelTh: 'รายได้จากการรับจ้างปล่อยดาวเทียมสู่อวกาศ (Launch Services) และการผลิตส่วนประกอบดาวเทียมส่งมอบให้ NASA/USSF',
    catalystsTh: 'การเปิดตัวจรวด Neutron, สัญญากับกระทรวงกลาโหมสหรัฐฯ (US Space Force) และความต้องการส่งดาวเทียมพุ่งสูงทั่วโลก',
  },
};

/** GET /api/company-profile/:symbol — Rich Business Description API */
app.get('/api/company-profile/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toUpperCase();
  
  if (COMPANY_THAI_PROFILES[symbol]) {
    return res.json(COMPANY_THAI_PROFILES[symbol]);
  }

  try {
    const summary = await yf.quoteSummary(symbol, { modules: ['assetProfile'] }, { validateResult: false });
    const profile = summary?.assetProfile || {};
    const rawSummary = profile.longBusinessSummary || '';
    
    let descriptionTh = 'บริษัทประกอบธุรกิจและดำเนินการในตลาดทุนสหรัฐฯ โดยมุ่งเน้นการสร้างรายได้และการเติบโตอย่างยั่งยืนในอุตสาหกรรม';
    if (rawSummary) {
      descriptionTh = await translateToThai(rawSummary.slice(0, 500));
    }

    res.json({
      nameTh: `${symbol} Corporation`,
      sectorTh: `${profile.sector || 'General'} / ${profile.industry || 'Business Services'}`,
      descriptionTh,
      productsTh: [
        `สินค้าและบริการหลักภายใต้แบรนด์ ${symbol}`,
        'การให้บริการแก่ลูกค้าองค์กรและผู้บริโภคทั่วไป',
        'การพัฒนาเทคโนโลยีและนวัตกรรมใหม่ในอุตสาหกรรม'
      ],
      revenueModelTh: 'สร้างรายได้จากการจำหน่ายสินค้า บริการสัญญาอนุญาต และการให้บริการโซลูชันแก่กลุ่มลูกค้าเป้าหมาย',
      catalystsTh: 'โอกาสการขยายส่วนแบ่งทางการตลาด การปรับปรุงประสิทธิภาพการดำเนินงาน และนวัตกรรมสินค้าใหม่',
      employees: profile.fullTimeEmployees || null,
      country: profile.country || 'United States',
      website: profile.website || null,
    });
  } catch {
    res.json({
      nameTh: `${symbol} Corporation`,
      sectorTh: 'US Stock Market',
      descriptionTh: `บริษัทชั้นนำที่จดทะเบียนซื้อขายในตลาดหุ้นสหรัฐฯ (${symbol})`,
      productsTh: ['สินค้าและบริการตามประเภทธุรกิจหลัก'],
      revenueModelTh: 'รายได้จากการดำเนินงานทางธุรกิจ',
      catalystsTh: 'การเติบโตตามสภาวะเศรษฐกิจและอุตสาหกรรม',
    });
  }
});


/** GET /api/movers/:type */
app.get('/api/movers/:type', async (req, res) => {
  const { type } = req.params;
  const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
  try {
    const result = await yf.screener({ scrIds: type, count: 10 }, {}, { validateResult: false });
    if (result?.quotes?.length) return res.json(result.quotes);
  } catch {}

  try {
    const quotes = await Promise.allSettled(MAG7.map(s => yf.quote(s, {}, { validateResult: false })));
    res.json(quotes.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value));
  } catch {
    res.json([]);
  }
});

/** GET /api/indices */
app.get('/api/indices', async (req, res) => {
  const INDICES = ['^GSPC', '^IXIC', '^DJI', '^RUT', '^VIX'];
  try {
    const results = await Promise.allSettled(
      INDICES.map(sym => yf.quote(sym, {}, { validateResult: false }))
    );
    res.json(results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value));
  } catch { res.json([]); }
});

function formatNewsDate(pubTime) {
  if (!pubTime) return 'เมื่อเร็วๆ นี้';
  let date;
  if (pubTime instanceof Date) {
    date = pubTime;
  } else if (typeof pubTime === 'number') {
    date = pubTime < 1e11 ? new Date(pubTime * 1000) : new Date(pubTime);
  } else if (typeof pubTime === 'string') {
    const num = Number(pubTime);
    if (!isNaN(num) && num > 0) {
      date = num < 1e11 ? new Date(num * 1000) : new Date(num);
    } else {
      date = new Date(pubTime);
    }
  } else {
    date = new Date();
  }

  if (isNaN(date.getTime())) return 'เมื่อเร็วๆ นี้';

  // Convert to Thailand time (UTC+7) manually to guarantee correct date/time
  const THAILAND_OFFSET_MS = 7 * 60 * 60 * 1000;
  const thailandTime = new Date(date.getTime() + THAILAND_OFFSET_MS);
  const day = thailandTime.getUTCDate();
  const monthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const month = monthNames[thailandTime.getUTCMonth()];
  const year = thailandTime.getUTCFullYear();
  const hours = String(thailandTime.getUTCHours()).padStart(2, '0');
  const minutes = String(thailandTime.getUTCMinutes()).padStart(2, '0');

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  let relativeText = '';
  if (diffMinutes < 1) relativeText = 'เมื่อสักครู่นี้';
  else if (diffMinutes < 60) relativeText = `${diffMinutes} นาทีที่แล้ว`;
  else if (diffMinutes < 1440) relativeText = `${Math.floor(diffMinutes / 60)} ชม. ที่แล้ว`;
  else relativeText = `${Math.floor(diffMinutes / 1440)} วันที่แล้ว`;
  return `${day} ${month} ${year} · ${hours}:${minutes} น. (${relativeText})`;
}

function isStockMarketRelated(item) {
  if (!item || !item.title) return false;
  const text = (item.title + ' ' + (item.summary || '') + ' ' + (item.publisher || '')).toLowerCase();

  const stockKeywords = [
    'stock', 'stocks', 'share', 'shares', 'earning', 'earnings', 'revenue', 'profit',
    'quarter', 'guidance', 'forecast', 'nasdaq', 'nyse', 's&p', 'dow', 'wall street',
    'market', 'investor', 'investors', 'analyst', 'analysts', 'target price', 'sec',
    'fed', 'interest rate', 'ai', 'chip', 'semiconductor', 'nvda', 'aapl', 'tsla',
    'msft', 'googl', 'amzn', 'meta', 'amd', 'pltr', 'rklb', 'avgo', 'smci', 'coin',
    'dividend', 'buyback', 'valuation', 'etf', 'option', 'trading', 'bull', 'bear',
    'bloomberg', 'reuters', 'cnbc', 'marketwatch', 'seeking alpha', 'barron', 'wsj',
    'หุ้น', 'ตลาดหุ้น', 'กำไร', 'รายได้', 'ผลประกอบการ', 'ปันผล', 'นักวิเคราะห์'
  ];

  return stockKeywords.some(kw => text.includes(kw));
}

function analyzeSentiment(titleStr = '', summaryStr = '') {
  const text = (titleStr + ' ' + summaryStr).toLowerCase();

  const bullishWords = [
    'surge', 'surges', 'surged', 'rally', 'rallies', 'rallied', 'soar', 'soars', 'soared',
    'beat', 'beats', 'beating', 'profit', 'profits', 'growth', 'upgraded', 'upgrade',
    'record', 'strong', 'buy', 'outperform', 'boost', 'boosts', 'jump', 'jumps', 'jumped',
    'gains', 'gained', 'bullish', 'high', 'higher', 'dividend', 'expand', 'expansion',
    'revenue up', 'earnings beat', 'target raised', 'guidance raised',
    'กำไร', 'เติบโต', 'พุ่ง', 'ทะยาน', 'ปรับขึ้น', 'ดีเกินคาด', 'เป้าเพิ่ม', 'ชนะตลาด', 'ผลบวก'
  ];

  const bearishWords = [
    'drop', 'drops', 'dropped', 'fall', 'falls', 'fallen', 'plunge', 'plunges', 'plunged',
    'decline', 'declines', 'declined', 'loss', 'losses', 'cut', 'cuts', 'down', 'downgrade',
    'downgraded', 'miss', 'misses', 'missed', 'warning', 'warns', 'risk', 'risks', 'fear',
    'fears', 'slump', 'slumps', 'lawsuit', 'selloff', 'bearish', 'lower', 'worst', 'slash',
    'layoff', 'layoffs', 'probe', 'investigation',
    'ร่วง', 'ดิ่ง', 'ทรุด', 'ขาดทุน', 'ลดลง', 'เตือน', 'ฟ้องร้อง', 'เสี่ยง', 'ปลดพนักงาน', 'ปรับลด'
  ];

  let bullScore = 0;
  let bearScore = 0;

  bullishWords.forEach(w => {
    if (text.includes(w)) bullScore += 1;
  });

  bearishWords.forEach(w => {
    if (text.includes(w)) bearScore += 1;
  });

  if (bullScore > bearScore) {
    return { sentiment: 'good', label: 'ข่าวดี', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0', icon: '🟢' };
  } else if (bearScore > bullScore) {
    return { sentiment: 'bad', label: 'ข่าวไม่ดี', color: '#E11D48', bg: '#FFE4E6', border: '#FECDD3', icon: '🔴' };
  } else {
    return { sentiment: 'neutral', label: 'ปานกลาง', color: '#475569', bg: '#F1F5F9', border: '#E2E8F0', icon: '⚪' };
  }
}

/** GET /api/news-all — Multi-Source Aggregator & Strict Stock Relevance Filter */
app.get('/api/news-all', async (req, res) => {
  try {
    const [res1, res2, res3, res4] = await Promise.all([
      yf.search('stock market news Reuters Bloomberg', { newsCount: 10, quotesCount: 0 }, { validateResult: false }),
      yf.search('CNBC MarketWatch SeekingAlpha US stocks', { newsCount: 10, quotesCount: 0 }, { validateResult: false }),
      yf.search('NVDA AAPL TSLA GOOGL MSFT AMZN META AMD stock news', { newsCount: 10, quotesCount: 0 }, { validateResult: false }),
      yf.search('Wall Street quarterly earnings Federal Reserve interest rates', { newsCount: 8, quotesCount: 0 }, { validateResult: false }),
    ]);

    const rawNews = [
      ...(res1?.news || []),
      ...(res2?.news || []),
      ...(res3?.news || []),
      ...(res4?.news || []),
    ];

    const uniqueNews = Array.from(new Map(rawNews.map(item => [item.uuid || item.link, item])).values());
    const stockOnlyNews = uniqueNews.filter(isStockMarketRelated);

    const translatedNews = await Promise.all(
      stockOnlyNews.slice(0, 18).map(async (item) => {
        const titleTh = await translateToThai(item.title);
        const summaryEn = item.summary || item.title;
        const summaryTh = await translateToThai(summaryEn);
        const thumbnail = extractThumbnail(item);
        const sentimentObj = analyzeSentiment(item.title, summaryEn);
        const symbolGuess = item.relatedTickers?.[0] || 'ตลาดหุ้น';
        const keyTakeawaysTh = generateThaiStockTakeaways(symbolGuess, item.title, summaryEn, titleTh, summaryTh);

        return {
          id: item.uuid || Math.random().toString(36).slice(2),
          title: item.title,
          titleTh,
          summaryEn,
          summaryTh,
          keyTakeawaysTh,
          publisher: item.publisher || 'Reuters / Financial News',
          link: item.link,
          time: formatNewsDate(item.providerPublishTime),
          thumbnail,
          relatedTickers: item.relatedTickers || [],
          sentiment: sentimentObj.sentiment,
          sentimentLabel: sentimentObj.label,
          sentimentColor: sentimentObj.color,
          sentimentBg: sentimentObj.bg,
          sentimentBorder: sentimentObj.border,
          sentimentIcon: sentimentObj.icon,
        };
      })
    );

    res.json(translatedNews);
  } catch { res.json([]); }
});

async function fetchOgImage(url) {
  if (!url || !url.startsWith('http') || url.includes('news.google.com')) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](.*?)["']/i)
                 || html.match(/<meta[^>]+content=["'](.*?)["'][^>]+property=["']og:image["']/i)
                 || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["'](.*?)["']/i);
    if (ogMatch && ogMatch[1] && ogMatch[1].startsWith('http')) {
      return ogMatch[1].replace(/&amp;/g, '&');
    }
  } catch {}
  return null;
}

/**
 * GNews API cache — 30 min TTL to conserve API quota (100 req/day free)
 */
const gnewsCache = new Map();
const GNEWS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch news from GNews API, Yahoo RSS, and Google News RSS with real article images
 */
async function fetchYahooFinanceNewsPage(symbol) {
  const sym = (symbol || '').toUpperCase();
  const items = [];
  const GNEWS_API_KEY = process.env.GNEWS_API_KEY || '90cbaccd79b250d3f8249b9470c49b06';

  // Build GNews search query from company keywords
  const companyNames = COMPANY_KEYWORDS[sym] || [sym];
  const gnewsQuery = encodeURIComponent(companyNames.slice(0, 2).join(' ') + ' stock');

  // Run GNews API, Yahoo RSS, and Google News RSS in parallel
  try {
    const [resGNews, resV2, resYfRss, resGnRss] = await Promise.allSettled([
      fetch(`https://gnews.io/api/v4/search?q=${gnewsQuery}&token=${GNEWS_API_KEY}&lang=en&max=10&sortby=publishedAt`, {
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://query2.finance.yahoo.com/v2/finance/news?symbols=${sym}&count=25&lang=en-US&region=US`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      }),
      fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }),
      fetch(`https://news.google.com/rss/search?q=${sym}+stock+when:90d&hl=en-US&gl=US&ceid=US:en`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
    ]);

    // Parse GNews API (PRIORITY — always has real article images!)
    // Check cache first to conserve API quota
    const gnewsCacheKey = `gnews-${sym}`;
    const cached = gnewsCache.get(gnewsCacheKey);
    if (cached && (Date.now() - cached.time) < GNEWS_CACHE_TTL) {
      items.push(...cached.articles);
      console.log(`🖼️ GNews CACHE HIT: ${cached.articles.length} articles for ${sym}`);
    } else if (resGNews.status === 'fulfilled' && resGNews.value.ok) {
      try {
        const data = await resGNews.value.json();
        const articles = data?.articles || [];
        console.log(`🖼️ GNews: ${articles.length} articles with real images for ${sym}`);
        for (const article of articles) {
          const title = article.title || '';
          if (!title || title.length < 5) continue;
          if (!items.some(x => x.title === title)) {
            items.push({
              uuid: `gnews-${sym}-${items.length}`,
              title,
              summary: article.description || article.content || title,
              publisher: article.source?.name || 'News',
              link: article.url || '',
              providerPublishTime: new Date(article.publishedAt).getTime() || Date.now(),
              realImage: article.image || null,
            });
          }
        }
        // Save to cache
        const gnewsItems = items.filter(x => x.uuid.startsWith('gnews-'));
        gnewsCache.set(gnewsCacheKey, { time: Date.now(), articles: gnewsItems });
      } catch (e) {
        console.warn('GNews parse error:', e.message);
      }
    }

    // Parse v2 API
    if (resV2.status === 'fulfilled' && resV2.value.ok) {
      try {
        const data = await resV2.value.json();
        const stories = data?.news || data?.items || data?.data?.stream || [];
        for (const story of stories) {
          const title = story.title || story.headline || '';
          if (!title || title.length < 5) continue;
          const imgUrl = story.thumbnail?.resolutions?.find(r => r.width >= 300)?.url
            || story.thumbnail?.resolutions?.[0]?.url
            || story.image?.url || story.img || null;
          items.push({
            uuid: story.uuid || story.id || `yfv2-${sym}-${items.length}`,
            title,
            summary: story.summary || story.description || title,
            publisher: story.publisher || story.source?.name || 'Yahoo Finance',
            link: story.link || story.url || `https://finance.yahoo.com/news/${story.uuid}`,
            providerPublishTime: story.providerPublishTime || story.pubTime || story.published || Date.now(),
            realImage: imgUrl,
          });
        }
      } catch {}
    }

    // Parse Yahoo RSS
    if (resYfRss.status === 'fulfilled' && resYfRss.value.ok) {
      try {
        const xml = await resYfRss.value.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
          const itemXml = match[1];
          const titleMatch = itemXml.match(/<title>(.*?)<\/title>/i);
          const linkMatch = itemXml.match(/<link>(.*?)<\/link>/i);
          const pubMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);
          const descMatch = itemXml.match(/<description>(.*?)<\/description>/i);

          let rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/gi, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : '';
          let rawLink = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/gi, '').trim() : '';
          let pubDateStr = pubMatch ? pubMatch[1].trim() : '';
          let rawDesc = descMatch ? descMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/gi, '').replace(/<[^>]+>/g, '').trim() : '';
          let xmlImg = extractImageFromXml(itemXml);

          if (rawTitle && rawTitle.length > 5 && !items.some(x => x.title === rawTitle)) {
            items.push({
              uuid: `yf-rss-${sym}-${items.length}`,
              title: rawTitle,
              summary: rawDesc.slice(0, 400) || rawTitle,
              publisher: 'Yahoo Finance',
              link: rawLink,
              providerPublishTime: new Date(pubDateStr).getTime() || Date.now(),
              realImage: xmlImg,
            });
          }
        }
      } catch {}
    }

    // Parse Google News RSS
    if (resGnRss.status === 'fulfilled' && resGnRss.value.ok) {
      try {
        const xml = await resGnRss.value.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
          const itemXml = match[1];
          const titleMatch = itemXml.match(/<title>(.*?)<\/title>/i);
          const linkMatch = itemXml.match(/<link>(.*?)<\/link>/i);
          const pubMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);
          const sourceMatch = itemXml.match(/<source[^>]*>(.*?)<\/source>/i);

          let rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/gi, '').replace(/&amp;/g, '&').trim() : '';
          let rawLink = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/gi, '').trim() : '';
          let pubDateStr = pubMatch ? pubMatch[1].trim() : '';
          let publisher = sourceMatch ? sourceMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/gi, '').trim() : 'Google News';
          let xmlImg = extractImageFromXml(itemXml);

          if (rawTitle && rawTitle.length > 5 && !items.some(x => x.title === rawTitle)) {
            items.push({
              uuid: `gn-${sym}-${items.length}`,
              title: rawTitle,
              summary: rawTitle,
              publisher,
              link: rawLink,
              providerPublishTime: new Date(pubDateStr).getTime() || Date.now(),
              realImage: xmlImg,
            });
          }
        }
      } catch {}
    }
  } catch(e) {
    console.warn(`⚠️ High speed news fetch error for ${sym}:`, e.message);
  }

  console.log(`📰 Total news for ${sym}: ${items.length} articles`);
  return items;
}

const COMPANY_KEYWORDS = {
  AAPL: ['AAPL', 'Apple'],
  NVDA: ['NVDA', 'Nvidia', 'NVIDIA'],
  TSLA: ['TSLA', 'Tesla'],
  MSFT: ['MSFT', 'Microsoft'],
  GOOGL: ['GOOGL', 'GOOG', 'Google', 'Alphabet'],
  GOOG: ['GOOGL', 'GOOG', 'Google', 'Alphabet'],
  AMZN: ['AMZN', 'Amazon'],
  META: ['META', 'Facebook', 'Instagram'],
  PLTR: ['PLTR', 'Palantir'],
  AMD: ['AMD', 'Advanced Micro Devices'],
  INTC: ['INTC', 'Intel'],
  NFLX: ['NFLX', 'Netflix'],
  DIS: ['DIS', 'Disney'],
  COIN: ['COIN', 'Coinbase'],
  ARM: ['ARM', 'Arm Holdings'],
  SMCI: ['SMCI', 'Super Micro'],
  RKLB: ['RKLB', 'Rocket Lab'],
  SOFI: ['SOFI', 'SoFi'],
  MSTR: ['MSTR', 'MicroStrategy'],
  MU: ['MU', 'Micron'],
  CRWD: ['CRWD', 'CrowdStrike'],
  SNOW: ['SNOW', 'Snowflake'],
  UBER: ['UBER', 'Uber'],
  ABNB: ['ABNB', 'Airbnb'],
  SHOP: ['SHOP', 'Shopify'],
  AVGO: ['AVGO', 'Broadcom'],
  QCOM: ['QCOM', 'Qualcomm'],
  TSM: ['TSM', 'Taiwan Semiconductor', 'TSMC'],
  COST: ['COST', 'Costco'],
  WMT: ['WMT', 'Walmart'],
  NKE: ['NKE', 'Nike'],
  PYPL: ['PYPL', 'PayPal'],
  PANW: ['PANW', 'Palo Alto Networks'],
  DELL: ['DELL', 'Dell'],
  SMR: ['SMR', 'NuScale'],
  MARA: ['MARA', 'Marathon Digital'],
  RIOT: ['RIOT', 'Riot Platforms'],
  HOOD: ['HOOD', 'Robinhood'],
  BA: ['BA', 'Boeing']
};

/** GET /api/news/:symbol — Multi-Source Yahoo Finance News Aggregator (ALL articles within 3 months) */
app.get('/api/news/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const symUpper = (symbol || '').toUpperCase();
  const kwList = COMPANY_KEYWORDS[symUpper] || [symUpper];

  try {
    // Fetch from RSS feeds only — works 100% on both localhost AND cloud (Render/AWS)
    // yf.search is NOT used here because Yahoo Finance blocks cloud datacenter IPs
    const companyName = kwList[1] || symUpper;
    const [rssItems, gnItems, gnPriceItems] = await Promise.allSettled([
      fetchYahooFinanceNewsPage(symUpper),
      // Extra Google News RSS with company name & earnings for more coverage
      fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(companyName + ' stock earnings revenue')}&hl=en-US&gl=US&ceid=US:en`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(async r => {
        if (!r.ok) return [];
        const xml = await r.text();
        const items = [];
        const re = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?(?:<source[^>]*>(.*?)<\/source>)?[\s\S]*?<\/item>/gi;
        let m;
        while ((m = re.exec(xml)) !== null) {
          const title = m[1].replace(/<!\[CDATA\[/gi,'').replace(/\]\]>/gi,'').replace(/&amp;/g,'&').trim();
          const link = m[2].replace(/<!\[CDATA\[/gi,'').replace(/\]\]>/gi,'').trim();
          const pub = m[3].trim();
          const publisher = (m[4]||'').replace(/<!\[CDATA\[/gi,'').replace(/\]\]>/gi,'').trim() || 'Google News';
          if (title && title.length > 5) items.push({ uuid: `gn2-${symUpper}-${items.length}`, title, summary: title, publisher, link, providerPublishTime: new Date(pub).getTime() || Date.now(), realImage: null });
        }
        return items;
      }).catch(() => []),
      // Direct price target & forecast RSS query
      fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(symUpper + ' stock price target forecast')}&hl=en-US&gl=US&ceid=US:en`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(async r => {
        if (!r.ok) return [];
        const xml = await r.text();
        const items = [];
        const re = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?(?:<source[^>]*>(.*?)<\/source>)?[\s\S]*?<\/item>/gi;
        let m;
        while ((m = re.exec(xml)) !== null) {
          const title = m[1].replace(/<!\[CDATA\[/gi,'').replace(/\]\]>/gi,'').replace(/&amp;/g,'&').trim();
          const link = m[2].replace(/<!\[CDATA\[/gi,'').replace(/\]\]>/gi,'').trim();
          const pub = m[3].trim();
          const publisher = (m[4]||'').replace(/<!\[CDATA\[/gi,'').replace(/\]\]>/gi,'').trim() || 'Wall Street Journal / Reuters';
          if (title && title.length > 5) items.push({ uuid: `gn3-${symUpper}-${items.length}`, title, summary: title, publisher, link, providerPublishTime: new Date(pub).getTime() || Date.now(), realImage: null });
        }
        return items;
      }).catch(() => []),
    ]);

    const rssNews   = rssItems.status === 'fulfilled' ? (rssItems.value || []) : [];
    const gnNews    = gnItems.status  === 'fulfilled' ? (gnItems.value  || []) : [];
    const gnPtNews  = gnPriceItems.status === 'fulfilled' ? (gnPriceItems.value || []) : [];

    const combinedRaw = [...rssNews, ...gnNews, ...gnPtNews];
    const map = new Map();
    for (const item of combinedRaw) {

      if (item.title && !map.has(item.title.toLowerCase().trim())) {
        map.set(item.title.toLowerCase().trim(), item);
      }
    }

    const uniqueNews = Array.from(map.values());
    const now = Date.now();
    const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

    // Strict filter: MUST be within 90 days AND MUST mention symbol/company name
    const focusedArticles = uniqueNews.filter(item => {
      // 1. Time check (within 90 days)
      if (item.providerPublishTime) {
        const pubTime = new Date(item.providerPublishTime).getTime();
        if (!isNaN(pubTime) && (now - pubTime) > THREE_MONTHS_MS) return false;
      }

      // 2. Strict keyword check (must be truly about this stock)
      const fullText = (item.title + ' ' + (item.summary || '') + ' ' + (item.link || '')).toLowerCase();
      const isMatch = kwList.some(kw => fullText.includes(kw.toLowerCase()));
      return isMatch;
    });

    console.log(`📰 Focused 3-month news for ${symUpper}: ${focusedArticles.length} articles`);

    const translated = await Promise.all(
      focusedArticles.slice(0, 50).map(async (item, idx) => {
        const titleTh = await translateToThai(item.title);
        const summaryEn = item.summary || item.title;
        const summaryTh = await translateToThai(summaryEn);
        const thumbnail = item.realImage || extractImageFromXml(item.summary) || extractThumbnail(item, symUpper, idx);
        const sentimentObj = analyzeSentiment(item.title, summaryEn);
        const keyTakeawaysTh = generateThaiStockTakeaways(symUpper, item.title, summaryEn, titleTh, summaryTh);

        return {
          id: item.uuid || Math.random().toString(36).slice(2),
          title: item.title,
          titleTh,
          summaryEn,
          summaryTh,
          keyTakeawaysTh,
          publisher: item.publisher || 'Yahoo Finance',
          link: item.link,
          time: formatNewsDate(item.providerPublishTime),
          thumbnail,
          relatedTickers: [symUpper],
          sentiment: sentimentObj.sentiment,
          sentimentLabel: sentimentObj.label,
          sentimentColor: sentimentObj.color,
          sentimentBg: sentimentObj.bg,
          sentimentBorder: sentimentObj.border,
          sentimentIcon: sentimentObj.icon,
        };
      })
    );

    res.json(translated);
  } catch(e) {
    console.error('News route error:', e.message);
    res.json([]);
  }
});


/** GET /api/news-full-content — Comprehensive Multi-Section Deep News Analysis */

app.get('/api/news-full-content', async (req, res) => {
  const articleUrl = req.query.url;
  const title = req.query.title || '';

  if (!articleUrl) return res.status(400).json({ error: 'URL is required' });

  if (fullArticleCache.has(articleUrl)) {
    return res.json(fullArticleCache.get(articleUrl));
  }

  try {
    let paragraphsEn = [];
    try {
      const response = await fetch(articleUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000),
      });
      if (response.ok) {
        const html = await response.text();
        paragraphsEn = extractArticleParagraphs(html);
      }
    } catch {}

    if (!paragraphsEn.length) {
      paragraphsEn = [
        title,
        'Wall Street institutional asset managers and quantitative hedge funds are closely tracking corporate financial results, macroeconomic policy shifts, and interest rate guidance.',
        'Market sentiment reflects dynamic recalibrations in valuation models across major technology hardware leaders, cloud software infrastructure providers, and semiconductor manufacturers.',
        'Institutional order flows indicate increased sensitivity to quarterly profit margins, free cash flow generation, and updated annual revenue forward guidance.',
        'Investors and portfolio managers are strongly advised to align entry and exit strategies with key Fibonacci technical support and resistance levels to systematically manage risk.'
      ];
    }

    const paragraphsTh = await Promise.all(
      paragraphsEn.map(p => translateToThai(p))
    );

    const validParagraphsTh = paragraphsTh.filter(p => p && !p.includes('MYMEMORY WARNING'));

    const titleTh = await translateToThai(title);
    const summaryPoints = [
      `📌 สรุปประเด็นหลัก: ${titleTh}`,
      `📊 ผลกระทบตลาด: ตลาดหุ้นตอบรับทิศทางผลประกอบการและคำแนะนำจากนักวิเคราะห์สถาบันอย่างใกล้ชิด`,
      `💡 มุมมองนักลงทุน: แนะนำประเมินสัดส่วนการลงทุนตามแนวรับ-แนวต้านเพื่อบริหารความเสี่ยงอย่างเป็นระบบ`
    ];

    const resultData = {
      titleTh,
      summaryPoints,
      paragraphsTh: validParagraphsTh.length ? validParagraphsTh : paragraphsEn,
      paragraphsEn,
    };

    fullArticleCache.set(articleUrl, resultData);
    res.json(resultData);
  } catch { res.json({}); }
});

/** GET /api/search?q=apple */
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json([]);
  try {
    const result = await yf.search(q, { quotesCount: 8, newsCount: 0 }, { validateResult: false });
    res.json((result?.quotes || []).filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF'));
  } catch { res.json([]); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHENTICATION ENDPOINTS (Email Login/Signup)
// ─────────────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');
const usersStore = new Map();

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      for (const [email, user] of Object.entries(raw)) {
        usersStore.set(email, user);
      }
      console.log(`👤 Loaded ${usersStore.size} registered users from disk`);
    }
  } catch {}
}

function saveUsers() {
  try {
    const obj = Object.fromEntries(usersStore);
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

loadUsers();

const otpStore = new Map();

/** POST /api/auth/send-otp — Send 6-digit OTP to Email for Verification */
app.post('/api/auth/send-otp', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรูปแบบอีเมลให้ถูกต้อง' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ ok: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 4 ตัวอักษร' });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (usersStore.has(cleanEmail)) {
    return res.status(400).json({ ok: false, error: 'อีเมลนี้ถูกลงทะเบียนแล้ว กรุณาเข้าสู่ระบบ' });
  }

  // Generate random 6-digit OTP
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes TTL

  otpStore.set(cleanEmail, {
    otp: otpCode,
    expiresAt,
    name: name || cleanEmail.split('@')[0],
    password,
  });

  console.log(`📩 OTP ${otpCode} generated for email -> ${cleanEmail}`);

  // Send OTP Email via Gmail SMTP
  const subject = `[StockWave] รหัสยืนยันอีเมล OTP ของคุณคือ: ${otpCode}`;
  const text =
    `สวัสดีครับคุณ ${name || cleanEmail}!\n\n` +
    `รหัสยืนยันอีเมล OTP 6 หลักของคุณสำหรับสมัครใช้งาน StockWave คือ:\n\n` +
    `🔑 ${otpCode}\n\n` +
    `(รหัส OTP นี้มีอายุใช้งาน 10 นาที โปรดอย่าเปิดเผยรหัสนี้แก่ผู้อื่น)\n\n` +
    `— ทีมงาน StockWave Alert System`;

  await sendEmail(cleanEmail, subject, text).catch(e => console.error('OTP Send error:', e.message));

  res.json({
    ok: true,
    message: `ส่งรหัสยืนยัน OTP 6 หลักไปยังอีเมล ${cleanEmail} เรียบร้อยแล้ว`,
  });
});

/** POST /api/auth/verify-otp — Verify OTP & Register User */
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกอีเมลและรหัส OTP 6 หลัก' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const otpData = otpStore.get(cleanEmail);

  if (!otpData || Date.now() > otpData.expiresAt) {
    return res.status(400).json({ ok: false, error: 'รหัส OTP หมดอายุหรือไม่มีข้อมูล กรุณากดส่งรหัสใหม่อีกครั้ง' });
  }

  if (otpData.otp !== otp.trim()) {
    return res.status(400).json({ ok: false, error: 'รหัส OTP ไม่ถูกต้อง กรุณาตรวจสอบรหัสในกล่องจดหมายอีเมลของคุณ' });
  }

  // Verification passed -> Save user
  const newUser = {
    email: cleanEmail,
    password: otpData.password,
    name: otpData.name,
    isPro: false,
    verified: true,
    createdAt: Date.now(),
  };

  usersStore.set(cleanEmail, newUser);
  saveUsers();
  otpStore.delete(cleanEmail);

  console.log(`✅ Email verified & user registered -> ${cleanEmail}`);

  res.json({
    ok: true,
    user: { email: newUser.email, name: newUser.name, isPro: false },
    message: 'ยืนยันอีเมลสำเร็จ สมัครสมาชิกและเข้าสู่ระบบเรียบร้อยแล้ว!',
  });
});

/** POST /api/auth/login — Real Email & Password Auth */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรูปแบบอีเมลให้ถูกต้อง' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const user = usersStore.get(cleanEmail);

  if (!user) {
    return res.status(404).json({ ok: false, error: 'ไม่พบอีเมลนี้ในระบบ กรุณาสมัครสมาชิกใหม่' });
  }

  if (user.password && password !== user.password) {
    return res.status(401).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' });
  }

  console.log(`🔐 Login success → ${cleanEmail}`);
  res.json({
    ok: true,
    user: { email: user.email, name: user.name, isPro: Boolean(user.isPro) },
  });
});

/** POST /api/auth/register — Real Signup & Email Welcome */
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรูปแบบอีเมลให้ถูกต้อง' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ ok: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 4 ตัวอักษร' });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (usersStore.has(cleanEmail)) {
    return res.status(400).json({ ok: false, error: 'อีเมลนี้ถูกลงทะเบียนแล้ว กรุณาเข้าสู่ระบบ' });
  }

  const newUser = {
    email: cleanEmail,
    password,
    name: name || cleanEmail.split('@')[0],
    isPro: false,
    createdAt: Date.now(),
  };

  usersStore.set(cleanEmail, newUser);
  saveUsers();
  console.log(`✨ Registered new user → ${cleanEmail}`);

  // Send Welcome Email via Gmail SMTP
  sendEmail(
    cleanEmail,
    '🎉 ยินดีต้อนรับสู่ StockWave Alert System',
    `สวัสดีครับคุณ ${newUser.name}!\n\nขอบคุณที่สมัครใช้งานระบบวิเคราะห์และแจ้งเตือนราคาหุ้น StockWave\nอีเมลนี้ผูกกับบัญชีของคุณเรียบร้อยแล้ว เมื่อราคาหุ้นแตะแนวรับ/แนวต้าน ระบบจะส่งการแจ้งเตือนเข้าอีเมลนี้โดยอัตโนมัติ 🚀\n\n— ทีมงาน StockWave`
  ).catch(() => {});

  res.json({
    ok: true,
    user: { email: newUser.email, name: newUser.name, isPro: false },
  });
});

/** POST /api/auth/subscribe-pro — Upgrade user to PRO and send confirmation */
app.post('/api/auth/subscribe-pro', async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรูปแบบอีเมลให้ถูกต้อง' });
  }

  const cleanEmail = email.trim().toLowerCase();
  let user = usersStore.get(cleanEmail);

  if (!user) {
    user = {
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      isPro: true,
      createdAt: Date.now(),
    };
  } else {
    user.isPro = true;
    if (name) user.name = name;
  }

  usersStore.set(cleanEmail, user);
  saveUsers();

  console.log(`👑 User subscribed to Pro → ${cleanEmail}`);

  // Send Pro Upgrade Confirmation Email
  sendEmail(
    cleanEmail,
    '👑 [StockWave Pro] ยินดีด้วย! คุณได้รับการอัปเกรดเป็นสมาชิก Pro เรียบร้อยแล้ว',
    `สวัสดีครับคุณ ${user.name}!\n\nขอบคุณสำหรับการอัปเกรดเป็นสมาชิก StockWave Pro (฿79/เดือน)\nขณะนี้บัญชี ${cleanEmail} ได้รับการปลดล็อกข้อมูลหุ้นทุกตัวในตลาดสหรัฐฯ กว่า 5,000+ หุ้น สัญญาณแนวรับ-แนวต้าน และฟังก์ชัน AI Scanner เรียบร้อยแล้ว 🚀\n\n— ทีมงาน StockWave`
  ).catch(() => {});

  res.json({
    ok: true,
    message: '🎉 สมัครสมาชิก Pro สำเร็จ! ปลดล็อกฟังก์ชันโปรทั้งหมดเรียบร้อยแล้ว',
    user: { email: user.email, name: user.name, isPro: true },
  });
});

const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'stockwave-admin-2026';

// ─── ADMIN SECURITY MIDDLEWARE ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey || req.body.adminKey;
  if (key !== ADMIN_SECRET_KEY) {
    console.warn(`🔒 Unauthorized Admin Access Attempt → IP: ${req.ip}`);
    return res.status(403).json({ ok: false, error: '🔒 สิทธิ์การเข้าถึงปฏิเสธ: Admin Secret Key ไม่ถูกต้อง' });
  }
  next();
}

app.use('/api/admin', requireAdmin);

/** POST /api/admin/grant-pro — Grant or Revoke PRO status */
app.post('/api/admin/grant-pro', (req, res) => {

  const { email, isPro = true } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'Email is required' });

  const cleanEmail = email.trim().toLowerCase();
  let user = usersStore.get(cleanEmail);

  if (!user) {
    user = {
      email: cleanEmail,
      name: cleanEmail.split('@')[0],
      isPro: Boolean(isPro),
      createdAt: Date.now(),
    };
  } else {
    user.isPro = Boolean(isPro);
  }

  usersStore.set(cleanEmail, user);
  saveUsers();

  console.log(`👑 Admin updated Pro status → ${cleanEmail} (isPro: ${user.isPro})`);
  res.json({ ok: true, message: `อัปเดตยศ PRO สำเร็จสำหรับ ${cleanEmail}`, user });
});

/** GET /api/admin/users — List all registered users */
app.get('/api/admin/users', (req, res) => {
  const usersList = Array.from(usersStore.values()).map(u => ({
    email: u.email,
    name: u.name,
    isPro: Boolean(u.isPro),
    createdAt: u.createdAt || Date.now(),
  }));
  res.json(usersList);
});

/** DELETE /api/admin/users/:email — Delete a user account */
app.delete('/api/admin/users/:email', (req, res) => {
  const cleanEmail = (req.params.email || '').trim().toLowerCase();
  if (usersStore.has(cleanEmail)) {
    usersStore.delete(cleanEmail);
    saveUsers();
    console.log(`🗑️ Admin deleted user → ${cleanEmail}`);
    return res.json({ ok: true, message: `ลบบัญชี ${cleanEmail} สำเร็จ` });
  }
  res.status(404).json({ ok: false, error: 'ไม่พบบัญชีผู้ใช้นี้' });
});

/** GET /api/admin/stats — System Overview Stats */
app.get('/api/admin/stats', (req, res) => {
  const users = Array.from(usersStore.values());
  const totalUsers = users.length;
  const proUsers = users.filter(u => u.isPro).length;
  
  let totalAlerts = 0;
  for (const symbolMap of alertsStore.values()) {
    totalAlerts += symbolMap.size;
  }

  res.json({
    totalUsers,
    proUsers,
    freeUsers: totalUsers - proUsers,
    totalAlerts,
    smtpActive: Boolean(process.env.GMAIL_USER && process.env.GMAIL_PASS),
    smsActive: Boolean(TWILIO_SID && TWILIO_AUTH),
    telegramActive: Boolean(TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'ใส่_Token_ของคุณ_ที่_นี่'),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

/** GET /api/admin/all-alerts — Get all price alerts across system */
app.get('/api/admin/all-alerts', (req, res) => {
  const allAlerts = [];
  for (const [userId, symbolMap] of alertsStore) {
    for (const [symbol, alert] of symbolMap) {
      allAlerts.push({
        userId,
        symbol,
        targetPrice: alert.targetPrice,
        direction: alert.direction,
        channel: alert.channel,
        phone: alert.phone,
        email: alert.email,
        createdAt: alert.createdAt,
        firedAt: alert.firedAt,
      });
    }
  }
  res.json(allAlerts);
});



// ─────────────────────────────────────────────────────────────────────────────
//  ALERT ENGINE ENDPOINTS (SMS + Telegram)
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/alerts — Save a price alert for a user */
app.post('/api/alerts', (req, res) => {
  const { chatId, phone, email, channel = 'sms', symbol, targetPrice, direction = 'below' } = req.body;

  // Build a stable userId that matches the channel being used
  let userId;
  if (channel === 'email' && email) userId = email.trim().toLowerCase();
  else if (channel === 'telegram' && chatId) userId = String(chatId).trim();
  else if (phone) userId = String(phone).trim();
  else userId = 'default';

  if (!symbol || targetPrice == null) {
    return res.status(400).json({ ok: false, error: 'symbol and targetPrice required' });
  }

  if (!alertsStore.has(userId)) {
    alertsStore.set(userId, new Map());
  }
  alertsStore.get(userId).set(symbol.toUpperCase(), {
    targetPrice: parseFloat(targetPrice),
    direction,
    channel,
    phone: phone || null,
    chatId: chatId || null,
    email: email || null,
    createdAt: Date.now(),
    firedAt: null,
  });
  saveAlerts();

  console.log(`✅ Alert saved → userId:${userId} channel:${channel} ${symbol} ${direction} $${targetPrice}`);
  res.json({ ok: true, userId, channel, symbol, targetPrice, direction });
});

/** GET /api/alerts/:userId — List all active alerts for a user */
app.get('/api/alerts/:userId', (req, res) => {
  const { userId } = req.params;
  const symbolMap = alertsStore.get(String(userId));
  if (!symbolMap) return res.json([]);
  const list = [...symbolMap.entries()].map(([symbol, alert]) => ({ symbol, ...alert }));
  res.json(list);
});

/** DELETE /api/alerts/:userId/:symbol — Remove a specific alert */
app.delete('/api/alerts/:userId/:symbol', (req, res) => {
  const { userId, symbol } = req.params;
  const symbolMap = alertsStore.get(String(userId));
  if (symbolMap) {
    symbolMap.delete(symbol.toUpperCase());
    if (symbolMap.size === 0) alertsStore.delete(String(userId));
    saveAlerts();
  }
  res.json({ ok: true });
});

/** POST /api/sms/send — Test SMS sending */
app.post('/api/sms/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });
  const result = await sendSMS(phone, text || '[StockWave Alert] ทดสอบการส่ง SMS เข้ามือถือเรียบร้อยแล้ว!');
  res.json(result);
});

/** POST /api/email/send — Test Email sending */
app.post('/api/email/send', async (req, res) => {
  const { to, subject, text } = req.body;
  if (!to) return res.status(400).json({ ok: false, error: 'to email is required' });
  const result = await sendEmail(
    to,
    subject || '🧪 [StockWave] ทดสอบการแจ้งเตือนอีเมล',
    text || '✅ ระบบแจ้งเตือนหุ้น StockWave ทำงานถูกต้อง!'
  );
  res.json(result);
});

/** GET /api/telegram/verify?chatId=xxx — Test Telegram connection */
app.get('/api/telegram/verify', async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required' });
  if (!TELEGRAM_API) return res.json({ ok: false, error: 'Bot Token not configured in .env' });

  const result = await sendTelegram(
    chatId,
    `✅ *เชื่อมต่อ StockWave สำเร็จ!*\n\n` +
    `📲 คุณจะได้รับการแจ้งเตือนเด้งบนมือถือทันที เมื่อราคาหุ้นถึงแนวรับที่ตั้งไว้\n\n` +
    `🔔 ระบบตรวจสอบราคาทุก *5 นาที* ตลอด 24 ชั่วโมง`
  );
  res.json(result);
});

/** POST /api/telegram/webhook — Auto-reply Chat ID */
app.post('/api/telegram/webhook', async (req, res) => {
  const update = req.body;
  const msg = update?.message;
  if (msg?.text?.startsWith('/start')) {
    const chatId    = msg.chat.id;
    const firstName = msg.chat.first_name || 'คุณ';
    await sendTelegram(
      chatId,
      `👋 สวัสดี *${firstName}!* ยินดีต้อนรับสู่ StockWave Alert Bot 🚀\n\n` +
      `📋 *Chat ID ของคุณคือ:*\n\`${chatId}\`\n\n` +
      `📌 *วิธีเชื่อมต่อ (ง่ายมาก):*\n` +
      `1️⃣ คัดลอกตัวเลข Chat ID ด้านบนนี้\n` +
      `2️⃣ เปิดแอป StockWave → ไปที่ ⚙️ ตั้งค่า\n` +
      `3️⃣ วาง Chat ID แล้วกด "ทดสอบการแจ้งเตือน"\n\n` +
      `✅ เสร็จแล้ว! คุณจะได้รับแจ้งเตือนเด้งมือถือทันที`
    );
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🚀 StockWave API → http://localhost:${PORT}`);
  console.log(`   Google Translate Unlimited Engine Active`);
  console.log(`   SMS Gateway Notification Engine Active 📱`);
  if (TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'ใส่_Token_ของคุณ_ที่_นี่') {
    console.log(`   Telegram Bot Active — checking prices every 5 min ✈️`);
  }
  console.log('');
});
