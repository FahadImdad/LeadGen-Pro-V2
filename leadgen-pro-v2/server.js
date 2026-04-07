const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./db');

const BUILD_TIME = new Date().toISOString();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API Keys from environment variables
const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY;
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Bright Data Scraping Browser endpoint
const BROWSER_WS = 'wss://brd-customer-hl_5aa18d97-zone-scraping_browser_1:nz185ss0b5p7@brd.superproxy.io:9222';

// Craigslist cities - GLOBAL (US + Canada + UK + Europe + Australia)
const CRAIGSLIST_CITIES = [
  // USA - Major Cities
  'sfbay', 'newyork', 'losangeles', 'chicago', 'seattle', 'boston', 'austin',
  'denver', 'miami', 'atlanta', 'dallas', 'phoenix', 'portland', 'sandiego',
  'washingtondc', 'philadelphia', 'houston', 'detroit', 'minneapolis', 'tampa',
  'orlando', 'nashville', 'charlotte', 'raleigh', 'saltlakecity', 'lasvegas',
  'sacramento', 'stlouis', 'pittsburgh', 'cleveland',
  'cincinnati', 'columbus', 'indianapolis', 'milwaukee', 'kansascity', 'memphis',
  'baltimore', 'richmond', 'newjersey', 'longisland',
  'orangecounty', 'inlandempire', 'ventura', 'santabarbara', 'fresno', 'bakersfield',
  // Canada
  'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'edmonton', 'winnipeg',
  // UK & Ireland
  'london', 'manchester', 'birmingham', 'edinburgh', 'glasgow', 'dublin',
  // Europe
  'amsterdam', 'berlin', 'paris', 'munich', 'hamburg', 'frankfurt', 'vienna', 'zurich', 'brussels', 'stockholm',
  // Australia & NZ
  'sydney', 'melbourne', 'brisbane', 'perth', 'auckland',
  // Asia
  'tokyo', 'hongkong', 'singapore', 'bangkok', 'seoul', 'taipei', 'manila',
  // India
  'bangalore', 'delhi', 'mumbai', 'chennai', 'hyderabad', 'pune', 'kolkata'
];

// ============================================================
// SHARED UTILITIES
// ============================================================

// Save a log entry to the job_logs table
async function saveLog(jobId, level, message) {
  await db.prepare('INSERT INTO job_logs (job_id, level, message) VALUES (?, ?, ?)').run(jobId, level, message);
}

// Scrape URL using Bright Data Web Unlocker (for simple requests like Reddit JSON)
async function scrapeWithBrightData(url, jobId = null) {
  try {
    const response = await axios.post('https://api.brightdata.com/request', {
      zone: 'web_unlocker_1',
      url: url,
      format: 'raw'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`
      },
      timeout: 20000,
      transformResponse: [(data) => data]
    });
    // Track BD usage per job
    if (jobId) {
      db.prepare('UPDATE scrape_jobs SET bd_calls = COALESCE(bd_calls, 0) + 1 WHERE id = ?').run(jobId).catch?.(() => {});
    }
    return response.data;
  } catch (error) {
    console.error('Bright Data error:', error.message);
    return null;
  }
}

// Semaphore to limit concurrent browser sessions (Bright Data has limited slots)
const BROWSER_CONCURRENCY = 20;

// DDG rate limit protection — max 10 concurrent DDG requests + jitter
let ddgActive = 0;
const DDG_MAX = 10;
const ddgQueue = [];
function ddgAcquire() {
  return new Promise(resolve => {
    if (ddgActive < DDG_MAX) { ddgActive++; resolve(); }
    else ddgQueue.push(resolve);
  });
}
function ddgRelease() {
  if (ddgQueue.length > 0) { ddgQueue.shift()(); }
  else ddgActive--;
}
async function ddgSearch(query) {
  await ddgAcquire();
  // Random jitter 0-500ms to avoid burst hitting DDG simultaneously
  await new Promise(r => setTimeout(r, Math.random() * 500));
  try {
    return await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
      maxRedirects: 2
    }).catch(() => null);
  } finally {
    ddgRelease();
  }
}
let browserActive = 0;
const browserQueue = [];
function browserAcquire() {
  return new Promise(resolve => {
    if (browserActive < BROWSER_CONCURRENCY) { browserActive++; resolve(); }
    else browserQueue.push(resolve);
  });
}
function browserRelease() {
  if (browserQueue.length > 0) { browserQueue.shift()(); }
  else browserActive--;
}

// Scrape using Bright Data Browser API (with JS rendering)
async function scrapeWithBrowser(url, waitSelector = null) {
  await browserAcquire();
  let browser = null;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 10000 }).catch(() => {});
    }

    const html = await page.content();
    await page.close();

    return html;
  } catch (error) {
    console.error('Browser API error:', error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    browserRelease();
  }
}

// Extract contact info using Gemini AI
async function extractContactsWithAI(text, title) {
  try {
    const prompt = `Extract contact information from this job post. Return JSON only, no explanation.

Title: ${title}
Post: ${text}

Return this exact JSON format:
{
  "name": "person's name or null",
  "email": "email address or null",
  "phone": "phone number or null",
  "whatsapp": "whatsapp number or null",
  "budget": "budget mentioned or null",
  "description": "brief description of what they need (max 100 chars)"
}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      },
      { timeout: 30000 }
    );

    const responseText = response.data.candidates[0]?.content?.parts[0]?.text || '{}';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return {};
  } catch (error) {
    console.error('Gemini error:', error.message);
    return {};
  }
}

// MX record cache
const mxCache = new Map();

// Verify email — MX check + trust custom domain emails found on author's own website
async function verifyEmail(email) {
  if (!email) return { valid: false };
  const dns = require('dns').promises;
  const domain = email.split('@')[1];
  const GENERIC_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','me.com','mac.com','aol.com','protonmail.com','live.com','msn.com'];

  try {
    // MX check — confirm domain has a mail server (catches fake/typo domains)
    let mx = mxCache.get(domain);
    if (!mx) {
      mx = await dns.resolveMx(domain).catch(() => null);
      if (mx && mx.length > 0) mxCache.set(domain, mx);
    }
    if (!mx || mx.length === 0) return { valid: false, status: 'no_mx' };

    // Custom domain email found on author's own website = HIGH confidence
    // (email physically exists on their site = they put it there = it's real)
    if (!GENERIC_DOMAINS.includes(domain)) return { valid: true, status: 'verified' };

    // Generic domain (Gmail etc) — valid MX but can't confirm inbox
    return { valid: true, status: 'accept_all' };
  } catch(e) {
    return { valid: true, status: 'accept_all' };
  }
}

// Hunter.io domain search — find emails for a given domain
async function findEmailByDomain(domain, firstName = '', lastName = '') {
  if (!domain || !HUNTER_API_KEY) return null;
  try {
    let url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}&limit=5`;
    const response = await axios.get(url, { timeout: 10000 });
    const emails = response.data?.data?.emails || [];
    if (emails.length === 0) return null;
    // Prefer person-type emails, then any
    const personEmail = emails.find(e => e.type === 'personal') || emails[0];
    return personEmail?.value || null;
  } catch (e) {
    return null;
  }
}

// Extract website URL from post body text
function extractWebsiteFromText(text) {
  const urlMatch = text.match(/https?:\/\/[^\s<>"')\]]+/i) ||
                   text.match(/www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
  if (!urlMatch) return null;
  let url = urlMatch[0];
  if (!url.startsWith('http')) url = 'https://' + url;
  // Filter out craigslist itself
  if (url.includes('craigslist.org')) return null;
  return url;
}

// ============================================================
// FRAMEWORK 1: INTENT LEADS (Craigslist + Reddit)
// ============================================================

// Scrape Craigslist using Bright Data Browser API with response interception
async function scrapeCraigslistCity(city, keyword, sendEvent) {
  const results = [];
  let browser = null;

  try {
    sendEvent('log', { level: 'brightdata', message: `🌐 BROWSER: Connecting to ${city}...` });

    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);

    let apiItems = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('sapi.craigslist.org') && url.includes('postings/search/full')) {
        try {
          const json = await response.json();
          const items = json?.data?.items || [];
          if (items.length > 0 && Array.isArray(items[0]) && items[0].length >= 10) {
            apiItems = items;
            sendEvent('log', { level: 'info', message: `📦 Captured ${items.length} items from API` });
          }
        } catch(e) {
          sendEvent('log', { level: 'warning', message: `⚠️ API parse error: ${e.message}` });
        }
      }
    });

    const searchUrl = keyword
      ? `https://${city}.craigslist.org/search/ggg?query=${encodeURIComponent(keyword)}`
      : `https://${city}.craigslist.org/search/ggg`;

    sendEvent('log', { level: 'brightdata', message: `🔗 Loading: ${searchUrl}` });

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    for (let i = 0; i < 10 && apiItems.length === 0; i++) {
      await new Promise(r => setTimeout(r, 500));
    }

    sendEvent('log', { level: 'info', message: `📊 Total API items captured: ${apiItems.length}` });

    for (const item of apiItems) {
      if (Array.isArray(item) && item.length >= 10) {
        const postingId = item[0];
        const title = item[item.length - 1];
        const slugArr = item.find(el => Array.isArray(el) && el[0] === 6);
        const urlSlug = slugArr ? slugArr[1] : 'gig';

        if (title && typeof title === 'string' && title.length > 5) {
          results.push({
            url: `https://${city}.craigslist.org/ggg/d/${urlSlug}/${postingId}.html`,
            title: title,
            price: '',
            city: city
          });
        }
      }
    }

    sendEvent('log', { level: 'success', message: `✅ ${city}: Found ${results.length} gigs` });
    await page.close();

  } catch (error) {
    sendEvent('log', { level: 'error', message: `❌ ${city}: ${error.message}` });
    console.error(`Craigslist ${city} error:`, error.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }

  return results;
}

// Parse individual Craigslist post
function parseCraigslistPost(html) {
  let body = '';

  const bodyMatch = html.match(/<section[^>]*id="postingbody"[^>]*>([\s\S]*?)<\/section>/i);
  if (bodyMatch) {
    body = bodyMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let postedDate = null;
  const dateMatch = html.match(/datetime="([^"]+)"/);
  if (dateMatch) {
    postedDate = dateMatch[1];
  }

  return { body, postedDate };
}

// Determine contact priority
function getContactPriority(lead) {
  if (lead.email && lead.emailVerified) return 1;
  if (lead.phone) return 2;
  if (lead.whatsapp) return 3;
  if (lead.email && !lead.emailVerified) return 4;
  return 6;
}

function getContactType(priority) {
  switch(priority) {
    case 1: return 'email';
    case 2: return 'phone';
    case 3: return 'whatsapp';
    case 4: return 'email_unverified';
    default: return 'website';
  }
}

// Scrape Reddit for freelance GIGS
// ── Upwork scraper ─────────────────────────────────────────────────────
async function scrapeUpwork(keyword, dateFrom, dateTo, sendEvent) {
  const results = [];
  try {
    const url = `https://www.upwork.com/search/jobs/?q=${encodeURIComponent(keyword)}&sort=recency`;
    sendEvent('log', { level: 'brightdata', message: `🌐 Upwork: Searching "${keyword}"...` });
    const html = await scrapeWithBrightData(url);
    if (!html) return results;

    const fromTs = new Date(dateFrom).getTime();
    const toTs = new Date(dateTo).getTime() + 86400000;

    // Extract job listings from Upwork JSON data embedded in page
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
    if (jsonMatch) {
      try {
        const state = JSON.parse(jsonMatch[1]);
        const jobs = state?.jobSearch?.results?.jobs || [];
        for (const job of jobs) {
          const postedTs = new Date(job.postedOn || job.createdOn || 0).getTime();
          if (postedTs < fromTs || postedTs > toTs) continue;
          results.push({
            title: job.title || 'Upwork Job',
            body: job.description || job.snippet || '',
            url: `https://www.upwork.com/jobs/${job.ciphertext || job.id}`,
            postedDate: new Date(postedTs).toISOString(),
            source: 'upwork',
            author: 'client'
          });
        }
      } catch(e) {}
    }

    // Fallback: regex extraction
    if (results.length === 0) {
      const titleMatches = html.matchAll(/<h2[^>]*class="[^"]*job-tile-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
      for (const m of titleMatches) {
        results.push({
          title: m[2].replace(/<[^>]+>/g, '').trim(),
          body: '',
          url: m[1].startsWith('http') ? m[1] : `https://www.upwork.com${m[1]}`,
          postedDate: new Date().toISOString(),
          source: 'upwork',
          author: 'client'
        });
      }
    }

    sendEvent('log', { level: 'success', message: `✅ Upwork: ${results.length} jobs found` });
  } catch(e) {
    sendEvent('log', { level: 'warning', message: `⚠️ Upwork error: ${e.message}` });
  }
  return results;
}

// ── Fiverr buyer requests scraper ──────────────────────────────────────
async function scrapeFiverr(keyword, sendEvent) {
  const results = [];
  try {
    const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&filter=rating`;
    sendEvent('log', { level: 'brightdata', message: `🌐 Fiverr: Searching "${keyword}"...` });
    const html = await scrapeWithBrightData(url);
    if (!html) return results;

    // Fiverr buyer requests page
    const reqUrl = `https://www.fiverr.com/requests/search?q=${encodeURIComponent(keyword)}`;
    const reqHtml = await scrapeWithBrightData(reqUrl);
    if (reqHtml) {
      const titleMatches = reqHtml.matchAll(/"title"\s*:\s*"([^"]{10,200})"/g);
      for (const m of titleMatches) {
        results.push({
          title: m[1],
          body: m[1],
          url: reqUrl,
          postedDate: new Date().toISOString(),
          source: 'fiverr',
          author: 'buyer'
        });
      }
    }
    sendEvent('log', { level: 'success', message: `✅ Fiverr: ${results.length} buyer requests found` });
  } catch(e) {
    sendEvent('log', { level: 'warning', message: `⚠️ Fiverr error: ${e.message}` });
  }
  return results;
}

// ── Twitter/X intent search ────────────────────────────────────────────
async function scrapeTwitter(keyword, dateFrom, dateTo, sendEvent) {
  const results = [];
  try {
    // Search Twitter for people asking about the keyword
    const query = `"${keyword}" (need OR looking OR hire OR want) -is:retweet lang:en`;
    const url = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;
    sendEvent('log', { level: 'brightdata', message: `🌐 Twitter/X: Searching for intent...` });
    const html = await scrapeWithBrightData(url);
    if (!html) return results;

    const fromTs = new Date(dateFrom).getTime();
    const toTs = new Date(dateTo).getTime() + 86400000;

    // Extract tweets from JSON
    const jsonMatches = html.matchAll(/"full_text"\s*:\s*"([^"]{20,500})"/g);
    for (const m of jsonMatches) {
      const text = m[1].replace(/\\n/g, ' ').replace(/\\u[\da-f]{4}/gi, '');
      if (text.toLowerCase().includes(keyword.toLowerCase())) {
        results.push({
          title: text.substring(0, 100),
          body: text,
          url: url,
          postedDate: new Date().toISOString(),
          source: 'twitter',
          author: 'twitter_user'
        });
      }
    }
    sendEvent('log', { level: 'success', message: `✅ Twitter: ${results.length} intent posts found` });
  } catch(e) {
    sendEvent('log', { level: 'warning', message: `⚠️ Twitter error: ${e.message}` });
  }
  return results;
}

// ── Facebook Groups search ─────────────────────────────────────────────
async function scrapeFacebookGroups(keyword, sendEvent) {
  const results = [];
  try {
    const url = `https://www.facebook.com/search/posts/?q=${encodeURIComponent(keyword + ' need help')}`;
    sendEvent('log', { level: 'brightdata', message: `🌐 Facebook: Searching groups...` });
    const html = await scrapeWithBrightData(url);
    if (!html) return results;

    // Extract post text from Facebook
    const postMatches = html.matchAll(/"message"\s*:\s*\{"text"\s*:\s*"([^"]{20,500})"/g);
    for (const m of postMatches) {
      const text = m[1].replace(/\\n/g, ' ');
      results.push({
        title: text.substring(0, 100),
        body: text,
        url: url,
        postedDate: new Date().toISOString(),
        source: 'facebook',
        author: 'facebook_user'
      });
    }
    sendEvent('log', { level: 'success', message: `✅ Facebook: ${results.length} posts found` });
  } catch(e) {
    sendEvent('log', { level: 'warning', message: `⚠️ Facebook error: ${e.message}` });
  }
  return results;
}

async function scrapeReddit(keyword, sendEvent, dateFrom, dateTo) {
  const results = [];

  const fromTs = new Date(dateFrom).getTime();
  const toTs = new Date(dateTo).getTime() + 86400000; // inclusive end
  sendEvent('log', { level: 'info', message: `⏰ Filtering posts from ${dateFrom} to ${dateTo}` });

  const subreddits = [
    { name: 'slavelabour', type: 'task', searchType: 'new' },
    { name: 'forhire', type: 'gig', searchType: 'search' },
    { name: 'Jobs4Bitcoins', type: 'task', searchType: 'new' },
    { name: 'freelance_forhire', type: 'gig', searchType: 'new' },
    { name: 'hiring', type: 'gig', searchType: 'search' },
    { name: 'DesignJobs', type: 'gig', searchType: 'new' },
    { name: 'gameDevJobs', type: 'gig', searchType: 'new' },
    // Book publishing specific
    { name: 'selfpublishing', type: 'gig', searchType: 'search' },
    { name: 'writing', type: 'gig', searchType: 'search' },
    { name: 'worldbuilding', type: 'gig', searchType: 'search' },
    { name: 'HireaWriter', type: 'gig', searchType: 'new' },
    { name: 'Ghostwriting', type: 'gig', searchType: 'search' },
  ];

  for (const sub of subreddits) {
    try {
      let url;
      if (sub.searchType === 'search') {
        url = `https://www.reddit.com/r/${sub.name}/search.json?q=${encodeURIComponent(keyword)}&restrict_sr=1&sort=new&limit=100`;
      } else {
        url = `https://www.reddit.com/r/${sub.name}/new.json?limit=100`;
      }

      sendEvent('log', { level: 'brightdata', message: `🌐 Fetching r/${sub.name}...` });

      // Delay between Reddit requests to avoid 429
      await new Promise(r => setTimeout(r, 3000));

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 30000
      });

      const posts = response.data?.data?.children || [];
      sendEvent('log', { level: 'info', message: `📋 r/${sub.name}: ${posts.length} posts` });

      for (const post of posts) {
        const p = post.data;
        const titleLower = p.title?.toLowerCase() || '';
        const flairLower = (p.link_flair_text || '').toLowerCase();
        const bodyLower = (p.selftext || '').toLowerCase();

        let isValidGig = false;

        if (sub.type === 'task') {
          const isTask = titleLower.includes('[task]') || flairLower.includes('task');
          const isOffer = titleLower.includes('[offer]') || flairLower.includes('offer');
          isValidGig = isTask && !isOffer;
        } else {
          const isGig =
            titleLower.includes('need') ||
            titleLower.includes('looking for') ||
            titleLower.includes('want') ||
            titleLower.includes('build') ||
            titleLower.includes('help') ||
            titleLower.includes('$') ||
            titleLower.includes('budget') ||
            bodyLower.includes('budget') ||
            bodyLower.includes('pay you');

          const isJob =
            titleLower.includes('position') ||
            titleLower.includes('salary') ||
            titleLower.includes('full-time') ||
            titleLower.includes('part-time') ||
            titleLower.includes('remote opportunit') ||
            titleLower.includes('junior') ||
            titleLower.includes('senior') ||
            titleLower.includes('mid-level') ||
            titleLower.includes('years experience') ||
            titleLower.includes('/yr') ||
            titleLower.includes('per year') ||
            titleLower.includes('contract') ||
            titleLower.includes('is hiring') ||
            titleLower.includes('company') ||
            titleLower.includes('onsite') ||
            titleLower.includes('hybrid') ||
            bodyLower.includes('salary') ||
            bodyLower.includes('benefits') ||
            bodyLower.includes('/yr');

          const isForHire =
            titleLower.includes('[for hire]') ||
            titleLower.includes('for hire') ||
            flairLower.includes('for hire');

          isValidGig = isGig && !isJob && !isForHire;
        }

        const matchesKeyword =
          !keyword ||
          keyword.trim() === '' ||
          sub.searchType === 'search' ||
          titleLower.includes(keyword.toLowerCase()) ||
          bodyLower.includes(keyword.toLowerCase());

        const postTime = p.created_utc * 1000;
        const isInRange = postTime >= fromTs && postTime <= toTs;

        if (isValidGig && matchesKeyword && isInRange) {
          results.push({
            title: p.title,
            body: p.selftext || '',
            url: `https://reddit.com${p.permalink}`,
            postedDate: new Date(postTime).toISOString(),
            source: `reddit/r/${sub.name}`,
            author: p.author
          });
          sendEvent('log', { level: 'success', message: `✅ GIG Found: ${p.title.substring(0, 50)}...` });
        }
      }
    } catch (error) {
      sendEvent('log', { level: 'warning', message: `⚠️ r/${sub.name}: ${error.message}` });
    }
  }

  sendEvent('log', { level: 'info', message: `📊 Total Reddit leads found: ${results.length}` });
  return results;
}

// ============================================================
// FRAMEWORK 2: AMAZON AUTHOR LEAD GEN
// ============================================================

const BLOCKED_DOMAINS = [
  'google.', 'amazon.', 'goodreads.', 'facebook.', 'twitter.', 'instagram.',
  'youtube.', 'linkedin.', 'pinterest.', 'reddit.', 'wikipedia.', 'bookbub.',
  'audible.', 'barnesandnoble.', 'thriftbooks.', 'booksrun.', 'penguinrandomhouse.',
  'harpercollins.', 'simonandschuster.', 'macmillan.', 'randomhouse.', 'scholastic.',
  'bloomsbury.', 'hachette.', 'abrams.', 'sourcebooks.', 'tiktok.', 'apple.',
  'microsoft.', 'cloudflare.', 'medium.com', 'substack.com', 'wordpress.com', 'blogger.com',
  'wix.com', 'squarespace.com', 'weebly.com', 'jimdo.com', 'site123.com',
  'strikingly.com', 'webnode.com', 'tumblr.com', 'myspace.com', 'booksamillion.com',
  'walmart.com', 'target.com', 'ebay.com', 'etsy.com', 'scribd.com', 'archive.org',
  'openlibrary.org', 'worldcat.org', 'librarything.com', 'kobo.com', 'smashwords.com',
  'lulu.com', 'bookbaby.com', 'ingramspark.com', 'wattpad.com', 'royalroad.com',
  'allauthor.com', 'authorsdb.com', 'fantasticfiction.com', 'publishersweekly.com',
  'kirkusreviews.com', 'netgalley.com', 'edelweiss.com', 'gstatic.com',
  'googleapis.com', 'sentry.io', 'aexp.com', 'jstor.org', 'gutenberg.org',
  'sermoncentral.com', 'bookbeat.com', 'gramercybooksbexley.com', 'awesomebooks.com',
  'bookmans.com', 'hymnary.org', 'jacket2.org', 'jimruttshow.com',
  'helpingcouplesheal.com', 'ieee.es', 'alabama.gov', 'bookmanager.com',
  'nytimes.com', 'theguardian.com', 'huffpost.com', 'buzzfeed.com',
  'bing.com', 'th.bing.com', 'cern.ch', 'cds.cern.ch', 'academia.edu',
  'researchgate.net', 'springer.com', 'wiley.com', 'tandfonline.com',
  'journals.', 'doi.org', 'ncbi.nlm.nih.gov', 'pubmed.',
  // Document / file sharing — not author websites
  'yumpu.com', 'slideshare.net', 'issuu.com', 'scribd.com', 'docplayer.net',
  'docslib.org', 'edoc.pub', 'pdfslide.net', 'vdocuments.mx', 'academia.edu',
  'researchgate.net', 'semanticscholar.org', 'arxiv.org', 'ssrn.com',
  // Book aggregators / retailers
  'thriftbooks.com', 'abebooks.com', 'alibris.com', 'chegg.com', 'vitalsource.com',
  'bookdepository.com', 'chapters.indigo.ca', 'waterstones.com', 'bookpeople.com',
  // Generic content farms
  'quora.com', 'answers.com', 'ehow.com', 'wikihow.com', 'thoughtco.com',
  'verywellmind.com', 'psychologytoday.com', 'healthline.com', 'webmd.com',
  'inc.com', 'entrepreneur.com', 'forbes.com', 'businessinsider.com',
];

function isRealAuthorWebsite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (BLOCKED_DOMAINS.some(d => host.includes(d))) return false;
    if (!/\.[a-z]{2,}$/.test(host)) return false;
    if (/\/(books|authors|search|catalog|directory|listing|store|shop)\//i.test(url)) return false;
    return true;
  } catch { return false; }
}

function isBlockedEmail(email) {
  if (!email || typeof email !== 'string') return true;
  if (email.match(/\.(png|jpg|jpeg|gif|svg|webp|js|css|min\.js|ts)(@|$)/i)) return true;
  // Block placeholder/example domains
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (/^(example\.com|test\.com|domain\.com|email\.com|yoursite\.com|yourdomain\.com|placeholder\.com|sample\.com)$/.test(domain)) return true;
  // Block placeholder local parts
  const local = email.split('@')[0].toLowerCase();
  if (/^(email|user|name|yourname|your\.name|your-name|firstname|lastname|your\.email|youremail|someone|test|info@info|hello@hello)$/.test(local)) return true;
  // Block clear spam/system emails — but allow info@, support@, contact@ on custom domains (handled as MEDIUM)
  if (/^(user|admin|noreply|no-reply|test|example|help|sales|webmaster|postmaster|hostmaster|abuse|privacy|legal|billing|accounts|newsletter|news|media|press|pr|marketing|staff|service|submit|submissions|invites|invite|orders|order|shop|store|social|digital|ventas|hola|bonjour|ciao|servicio)@/i.test(email)) return true;
  if (/\d+\.\d+\.\d+/.test(email)) return true;
  if (local.length > 40) return true;
  if (BLOCKED_DOMAINS.some(d => email.toLowerCase().includes(d))) return true;
  if (!domain.includes('.')) return true;
  return false;
}

// Check if email is likely the author's personal email (must contain their name)
function isLikelyAuthorEmail(email, authorName) {
  if (!email || !authorName) return false;
  const local = email.split('@')[0].toLowerCase();
  const domain = (email.split('@')[1] || '').toLowerCase();
  const cleanName = authorName.toLowerCase().replace(/[^a-z\s]/g, '');
  const nameParts = cleanName.split(/\s+/).filter(p => p.length > 2);

  // Check if haystack contains needle or a close variation (handles name spelling variants)
  function fuzzyContains(haystack, needle) {
    if (haystack.includes(needle)) return true;
    if (needle.length < 4) return false;
    // Try all 4-char substrings of needle in haystack (catches vivika/viveka type variants)
    for (let i = 0; i <= needle.length - 4; i++) {
      const sub = needle.substring(i, i + 4);
      if (haystack.includes(sub)) return true;
    }
    // Also try needle without vowels (consonant skeleton match)
    const consonants = needle.replace(/[aeiou]/g, '');
    if (consonants.length >= 3 && haystack.replace(/[aeiou]/g, '').includes(consonants)) return true;
    return false;
  }

  // If email domain contains author name → strong signal
  const domainHasName = nameParts.some(part => fuzzyContains(domain, part));
  if (domainHasName) return true;

  // If local part contains author's first or last name → good signal
  const localHasName = nameParts.some(part => fuzzyContains(local, part));
  if (localHasName) return true;

  // Only accept emails where author's name appears in domain OR local part
  // Rejects generic emails like info@, contact@, hello@ that could belong to anyone
  return false;
}

// Amazon category node IDs — each supports 400 pages of search results (~16,000 books per category)
// URL format: https://www.amazon.com/s?i=stripbooks&rh=n:NODE_ID&page=N&s=date-desc-rank
const AMAZON_CATEGORY_NODES = [
  { id: '2635',      name: 'Business & Money' },
  { id: '4736',      name: 'Self Help' },
  { id: '6',         name: 'Health & Fitness' },
  { id: '486994011', name: 'Biographies' },
  { id: '22',        name: 'Religion & Spirituality' },
  { id: '4919',      name: 'Parenting' },
  { id: '75',        name: 'Science & Math' },
  { id: '9',         name: 'History' },
  { id: '11232',     name: 'Politics & Social' },
  { id: '2642',      name: 'Travel' },
  { id: '4677',      name: 'Education' },
  { id: '3',         name: 'Children' },
  { id: '4',         name: 'Computers & Tech' },
  { id: '173507',    name: 'Arts & Photography' },
  { id: '3510',      name: 'Romance' },
  { id: '2501',      name: 'Entrepreneurship' },
  { id: '2579',      name: 'Leadership' },
  { id: '2558',      name: 'Marketing' },
  { id: '2533',      name: 'Investing' },
  { id: '2531',      name: 'Personal Finance' },
  { id: '4507',      name: 'Motivational' },
  { id: '4734',      name: 'Anxiety & Phobias' },
  { id: '4744',      name: 'Relationships' },
  { id: '10',        name: 'Diet & Weight Loss' },
  { id: '12',        name: 'Mental Health' },
  { id: '12290',     name: 'Christianity' },
  { id: '12293',     name: 'Islam' },
  { id: '12291',     name: 'Spirituality' },
  { id: '10672',     name: 'Literature & Fiction' },
  { id: '49',        name: 'Mystery & Thriller' },
  { id: '48',        name: 'Science Fiction' },
  { id: '47',        name: 'Fantasy' },
  { id: '695398',    name: 'Historical Fiction' },
  { id: '700200',    name: 'Memoirs' },
  { id: '28',        name: 'Teen & Young Adult' },
  { id: '173514',    name: 'Law' },
  { id: '173513',    name: 'Medical' },
  { id: '298471',    name: 'Music' },
];

// Each category supports up to ~99 pages (~20 books/page = ~1,980 books per category)
// Page 100+ returns empty — tested live
const MAX_PAGES_PER_URL = 95;

function buildAmazonUrl(dateFrom, dateTo, page = 1) { return null; } // legacy stub

// Amazon format filter codes:
// Paperback: p_n_feature_browse-bin:2656022011
// Hardcover: p_n_feature_browse-bin:2656022011 (same node, different value)
// Kindle:    p_n_feature_browse-bin:618073011
// No filter = all formats
const FORMAT_FILTERS = [
  { code: '2656022011', name: 'Paperback' },
  { code: '2656022011', name: 'Hardcover' }, // will detect from HTML
  { code: '618073011',  name: 'Kindle' },
];

// Amazon Advanced Search URL — uses month/year pub date filter (works for any historical date)
// Format codes: Paperback=2656022011, Hardcover=2576410011, Kindle=618073011
// Condition: New=1294423011
// p_45=month (1-12), p_47=year, p_46=During
const ADV_FORMAT_CODES = [
  '2656022011', // Paperback
  '2576410011', // Hardcover
  '618073011',  // Kindle
];

function getAmazonUrl(urlIndex, page, formatFilter = '', dateFrom = '', dateTo = '') {
  const pg = Math.max(1, Math.min(page, MAX_PAGES_PER_URL));

  // Parse month/year from dateFrom (YYYY-MM-DD)
  let month = 1, year = new Date().getFullYear();
  if (dateFrom && dateFrom.length >= 7) {
    const parts = dateFrom.split('-');
    year  = parseInt(parts[0]) || year;
    month = parseInt(parts[1]) || month;
  }

  // Rotate through format codes across urlIndex (Paperback → Hardcover → Kindle)
  const formatCode = ADV_FORMAT_CODES[urlIndex % ADV_FORMAT_CODES.length];

  // Build Amazon Advanced Search URL
  // rh params: condition=New, format=formatCode, language=English
  const rh = `p_n_condition-type%3A1294423011%2Cp_n_feature_browse-bin%3A${formatCode}%2Cp_20%3AEnglish`;
  return `https://www.amazon.com/s?i=stripbooks&rh=${rh}&s=date-desc-rank&p_45=${month}&p_46=During&p_47=${year}&page=${pg}&unfiltered=1&ref=sr_adv_b`;
}

// Parse Amazon search results HTML (Web Unlocker) into book objects
// Pattern confirmed from live HTML: title in <h2 ...><span>TITLE</span>, author after "by </span><span>AUTHOR</span>"
function parseAmazonNewReleasesHtml(html) {
  const books = [];

  function decodeEntities(s) {
    return s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }

  // Pattern confirmed from live HTML:
  // <h2 ... class="a-size-medium a-spacing-none a-color-base a-text-normal"><span>TITLE</span></h2></a>
  // followed by: by </span><span class="a-size-base">AUTHOR</span>
  // The title also appears earlier in alt="" — we MUST match the h2 span specifically
  const titleRe = /<h2[^>]*class="a-size-medium a-spacing-none a-color-base a-text-normal"[^>]*><span>([^<]{5,250})<\/span><\/h2>/g;
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    const title = decodeEntities(m[1]);
    if (!title || title.length < 5) continue;

    // Look backwards up to 1000 chars for the ASIN in the /dp/ASIN/ URL
    const before = html.substring(Math.max(0, m.index - 1000), m.index);
    const asinM = before.match(/\/dp\/([A-Z0-9]{10})\//g);
    const asin = asinM ? asinM[asinM.length - 1].replace('/dp/', '').replace('/', '') : null;
    if (!asin) continue;

    // Look forward 800 chars for author, reviews, date
    const after = html.substring(m.index + m[0].length, m.index + m[0].length + 800);

    // Author — two patterns:
    // 1. <span class="a-size-base">by </span><span ...>AUTHOR</span>  (plain text author)
    // 2. <span class="a-size-base">by </span><a ...>AUTHOR</a>         (linked author)
    const authorM = after.match(/by <\/span><span[^>]*>([^<]{2,80})<\/span>/) ||
                    after.match(/by <\/span><a[^>]*>([^<]{2,80})<\/a>/);
    const author = authorM ? decodeEntities(authorM[1]) : 'Unknown';

    // Publication date — fix truncated year (Amazon shows "Apr 2, 202" instead of "Apr 2, 2026")
    const dateM = after.match(/a-color-secondary a-text-normal">([^<]{4,30})<\/span>/);
    let publishDate = dateM ? decodeEntities(dateM[1]) : '';
    // Fix truncated year: "Apr 2, 202" → "Apr 2, 2026" (assume current decade)
    if (publishDate && /[A-Za-z]+ \d{1,2}, \d{3}$/.test(publishDate.trim())) {
      const currentYear = new Date().getFullYear().toString();
      publishDate = publishDate.trim() + currentYear.slice(-1); // append last digit of year
    }

    // Publisher — paperback listings show it in several patterns
    // Pattern 1: "Publisher : <a>NAME</a>" or "Publisher : NAME"
    // Pattern 2: after date row "by ... | Publisher name" in a-row
    // Pattern 3: a-color-secondary containing publisher after date
    const publisherM =
      after.match(/[Pp]ublisher\s*[:\–\-]\s*<[^>]+>([^<]{2,80})<\//) ||
      after.match(/[Pp]ublisher\s*[:\–\-]\s*([A-Za-z][^\n<]{2,60})/) ||
      after.match(/class="[^"]*publisher[^"]*"[^>]*>([^<]{2,80})<\//i) ||
      after.match(/a-color-secondary[^>]*>\s*([A-Z][a-zA-Z\s&,\.]{3,50})\s*<\/span>\s*<\/div>\s*<div[^>]*>.*?(?:Paperback|Hardcover)/s) ||
      after.match(/(?:Paperback|Hardcover)[^<]*<[^>]+>[^<]*<\/[^>]+>\s*(?:<[^>]+>)*([A-Z][a-zA-Z0-9\s&,\.\-]{3,50})<\/[a-z]+>\s*<\/div>/);
    const publisher = publisherM ? decodeEntities(publisherM[1].trim()).replace(/\s+/g,' ').substring(0,60) : '';

    // Review count — aria-label="X ratings" or popoverLabel "X out of 5 stars"
    const fullArea = before.substring(before.length - 500) + after;
    const reviewM = fullArea.match(/aria-label="([\d,]+) ratings?"/i) ||
                    fullArea.match(/"([\d,]+) global ratings?"/i) ||
                    fullArea.match(/(\d+)\s*customer reviews?/i);
    const reviewCount = reviewM ? parseInt(reviewM[1].replace(/,/g, '')) : 0;

    // Detect book format from listing card
    const formatArea = after.substring(0, 400);
    let bookFormat = 'Unknown';
    if (/Audiobook|Audible|Audio CD/i.test(formatArea)) bookFormat = 'Audiobook';
    else if (/Kindle|eBook|Digital/i.test(formatArea)) bookFormat = 'Kindle';
    else if (/Hardcover/i.test(formatArea)) bookFormat = 'Hardcover';
    else if (/Paperback/i.test(formatArea)) bookFormat = 'Paperback';

    // Check if other format ASINs are listed (format switcher on listing card)
    // Pattern: other-offers links or binding switcher with different ASINs
    const fullCard = html.substring(Math.max(0, m.index - 500), m.index + m[0].length + 1200);
    const formatLinks = [...fullCard.matchAll(/\/dp\/([A-Z0-9]{10})\/[^"]*"[^>]*>[^<]*(Paperback|Hardcover|Kindle|Audiobook)/gi)];
    let preferredAsin = asin;
    let preferredFormat = bookFormat;
    // Priority: Paperback > Hardcover > Kindle > Audiobook
    const formatPriority = { 'Paperback': 4, 'Hardcover': 3, 'Kindle': 2, 'Unknown': 1, 'Audiobook': 0 };
    for (const [, altAsin, altFormat] of formatLinks) {
      if (altAsin !== asin && formatPriority[altFormat] > formatPriority[preferredFormat]) {
        preferredAsin = altAsin;
        preferredFormat = altFormat;
      }
    }

    books.push({ asin: preferredAsin, title, author, publisher, publishDate, reviewCount, bookFormat: preferredFormat, amazonUrl: `https://www.amazon.com/dp/${preferredAsin}` });
  }

  return books;
}

// Scrape Amazon new releases and return book objects
async function scrapeAmazonBooks(targetLeads, dateFrom, dateTo, sendEvent) {
  const books = [];
  let browser = null;
  let page_num = 1;
  // We scrape more pages than needed since not all will have verified emails
  const maxPages = 50;

  sendEvent('log', { level: 'brightdata', message: `🌐 BROWSER: Connecting to Amazon...` });

  try {
    browser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS });

    while (page_num <= maxPages) {
      const url = buildAmazonUrl(dateFrom, dateTo, page_num);
      sendEvent('log', { level: 'info', message: `📄 Scraping page ${page_num}: ${url}` });

      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(60000);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 15000 }).catch(() => {});

        const pageBooks = await page.$$eval('[data-component-type="s-search-result"]', (items) => {
          return items.map(item => {
            const asin = item.getAttribute('data-asin') || '';
            const titleEl = item.querySelector('h2 a span') || item.querySelector('.a-size-medium') || item.querySelector('.a-size-base-plus');
            const title = titleEl ? titleEl.textContent.trim() : '';
            const authorEl = item.querySelector('.a-row .a-size-base+ .a-size-base') ||
                             item.querySelector('[class*="author"] .a-link-normal') ||
                             item.querySelector('.a-row a.a-link-normal');
            const author = authorEl ? authorEl.textContent.trim() : '';
            const dateEl = item.querySelector('.a-color-secondary .a-size-base') ||
                           item.querySelector('[class*="publication"]');
            const publishDate = dateEl ? dateEl.textContent.trim() : '';
            return { asin, title, author, publishDate };
          }).filter(b => b.asin && b.title);
        });

        await page.close();

        if (pageBooks.length === 0) {
          sendEvent('log', { level: 'warning', message: `⚠️ No books found on page ${page_num}, stopping pagination` });
          break;
        }

        for (const book of pageBooks) {
          books.push({
            ...book,
            amazonUrl: `https://www.amazon.com/dp/${book.asin}`
          });
        }

        sendEvent('log', { level: 'success', message: `✅ Page ${page_num}: ${pageBooks.length} books (total buffered: ${books.length})` });
        page_num++;

        await new Promise(r => setTimeout(r, 1500));

      } catch (pageError) {
        await page.close().catch(() => {});
        sendEvent('log', { level: 'error', message: `❌ Page ${page_num} error: ${pageError.message}` });
        break;
      }
    }
  } catch (error) {
    sendEvent('log', { level: 'error', message: `❌ Amazon scrape error: ${error.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return books;
}

// Find author contact info — sequential with early exit to avoid connection exhaustion
async function findAuthorContact(authorName, bookTitle, saveLog, jobId = null) {
  // Skip unknown authors — no point searching for "Unknown"
  if (!authorName || authorName === 'Unknown' || authorName.trim().length < 3) {
    saveLog('info', `⏩ Skipping unknown author`);
    return { email: null, website: null };
  }

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const firstName = authorName.split(' ')[0].toLowerCase();
  const lastName = authorName.split(' ').slice(-1)[0].toLowerCase();
  const nameSlug = authorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const nameParts = authorName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(p => p.length > 2);

  function extractEmails(html) {
    const raw = [...new Set((html.match(emailRegex) || []).filter(e => !isBlockedEmail(e)))];
    // Priority 1: name in local part (john@johnsmith.com) — strongest signal
    const nameInLocal = raw.filter(e => {
      const local = e.split('@')[0].toLowerCase();
      return nameParts.some(p => local.includes(p));
    });
    if (nameInLocal.length > 0) return nameInLocal;
    // Priority 2: name in domain (info@johnsmith.com) — still theirs
    const nameInDomain = raw.filter(e => {
      const domain = (e.split('@')[1] || '').toLowerCase();
      return nameParts.some(p => domain.includes(p));
    });
    if (nameInDomain.length > 0) return nameInDomain;
    // No name match → return empty (don't pick random emails from the page)
    return [];
  }

  function extractRealWebsites(html) {
    const urlRegex = /href="(https?:\/\/[^"#?]{10,}[^"#?])"/g;
    let m; const candidates = [];
    while ((m = urlRegex.exec(html)) !== null) {
      if (isRealAuthorWebsite(m[1])) candidates.push(m[1]);
    }
    return [...new Set(candidates)].sort((a,b) => a.length - b.length);
  }

  async function fetchEmails(url) {
    try {
      // Try direct HTTP first (FREE) — author sites rarely block scrapers
      let html = null;
      const ROTATE_UA = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0',
      ];
      try {
        const resp = await axios.get(url, {
          timeout: 6000,
          maxRedirects: 3,
          headers: {
            'User-Agent': ROTATE_UA[Math.floor(Math.random() * ROTATE_UA.length)],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
          },
          validateStatus: s => s < 400
        });
        if (resp.data && typeof resp.data === 'string' && resp.data.length > 500) {
          html = resp.data;
        }
      } catch(e) {}

      // Fallback to BD only if direct HTTP failed — skip /contact and /about on BD (save cost)
      if (!html && !url.includes('/contact') && !url.includes('/about')) {
        html = await scrapeWithBrightData(url, jobId);
      }

      if (!html) return { email: null, website: null, html: null };
      const emails = extractEmails(html);
      const sites = extractRealWebsites(html);
      return { email: emails[0] || null, website: sites[0] || null, html };
    } catch(e) { return { email: null, website: null, html: null }; }
  }

  saveLog('info', `🔍 ${authorName}...`);

  // ══════════════════════════════════════════════════════════════
  // EMAIL FINDING FLOW
  // Step 1: Hunter on guessed domains (finds emails even if not public)
  // Step 2: DDG + domain guess to find website
  // Step 3: Hunter on found domain
  // Step 4: Scrape website as last resort
  // ══════════════════════════════════════════════════════════════

  // ── STEP 1: Hunter on guessed domains (finds emails even without website) ──
  const domainCandidates = [
    `${firstName}${lastName}.com`,
    `${nameSlug}.com`,
    `${firstName}-${lastName}.com`,
    `${firstName}${lastName}author.com`,
    `author${firstName}${lastName}.com`,
    `${nameSlug}author.com`,
    `author${nameSlug}.com`,
  ];

  // Skip Hunter on guessed domains — too many false hits, wastes credits + time
  // Hunter is called later on the CONFIRMED domain (more accurate)

  // ── STEP 2: Find author website — DDG + domain guessing ──
  let foundWebsite = null;
  const bookTitleShort = (bookTitle || '').split(':')[0].substring(0, 40);
  const searchQuery = bookTitleShort
    ? `"${authorName}" "${bookTitleShort}"`
    : `"${authorName}" author official website`;

  const [ddgResult, ...domainResults] = await Promise.all([
    ddgSearch(searchQuery),
    ...domainCandidates.map(domain =>
      axios.get(`https://${domain}`, {
        timeout: 3000, maxRedirects: 2,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        validateStatus: s => s < 400
      }).then(r => r.status < 400 ? `https://${domain}` : null).catch(() => null)
    )
  ]);

  if (ddgResult?.data) {
    const sites = extractRealWebsites(ddgResult.data);
    foundWebsite = sites.find(s => {
      try {
        const host = new URL(s).hostname.toLowerCase().replace(/^www\./, '');
        return nameParts.some(p => host.includes(p));
      } catch { return false; }
    }) || sites[0] || null;
  }
  if (!foundWebsite) foundWebsite = domainResults.find(r => r !== null) || null;

  if (!foundWebsite) {
    saveLog('info', `⏩ No website for ${authorName}`);
    return { email: null, website: null };
  }

  saveLog('info', `🌐 ${foundWebsite}`);

  // ── STEP 3+4: Hunter on found domain + website scrape IN PARALLEL ──
  const base = foundWebsite.replace(/\/$/, '');
  const foundDomain = new URL(foundWebsite).hostname.replace(/^www\./, '');

  // Scrape website first (free) — Hunter only if nothing found (saves credits)
  const [homeResult, contactResult, aboutResult] = await Promise.all([
    fetchEmails(base),
    fetchEmails(`${base}/contact`),
    fetchEmails(`${base}/about`)
  ]);

  const found = homeResult.email || contactResult.email || aboutResult.email;
  if (found) {
    saveLog('success', `📧 Found on website: ${found}`);
    return { email: found, website: foundWebsite };
  }

  // Hunter as fallback — only called when website has no email
  if (HUNTER_API_KEY) {
    try {
      const r = await axios.get(
        `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(foundDomain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_API_KEY}`,
        { timeout: 8000 }
      ).catch(() => null);
      // Track Hunter call — only counts credit if email found (per Hunter docs)
      const hunterEmail = r?.data?.data?.email;
      const score = r?.data?.data?.score || 0;
      if (hunterEmail && jobId) {
        // Credit used — email was found
        db.prepare('UPDATE scrape_jobs SET hunter_calls = COALESCE(hunter_calls, 0) + 1 WHERE id = ?').run(jobId).catch?.(() => {});
      }
      if (hunterEmail && score >= 30) {
        saveLog('success', `📧 Hunter: ${hunterEmail} (${score}%)`);
        return { email: hunterEmail, website: foundWebsite };
      }
    } catch(e) {}
  }

  saveLog('info', `⏩ No email found for ${authorName} (website-only)`);
  return { email: null, website: foundWebsite };
}

// ============================================================
// API ENDPOINTS
// ============================================================

// GET /api/ping — keepalive / wake-up
app.get('/api/ping', async (req, res) => res.json({ ok: true, time: Date.now() }));

// GET /api/jobs — list all scrape jobs
app.get('/api/jobs', async (req, res) => {
  const jobs = await db.prepare('SELECT * FROM scrape_jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

// GET /api/jobs/:jobId/leads — fetch verified leads for display in table
app.get('/api/jobs/:jobId/leads', async (req, res) => {
  const { jobId } = req.params;
  const { framework = 'amazon' } = req.query;
  let leads;
  if (framework === 'amazon') {
    // Return verified leads first, then website-only leads (no email but has website)
    leads = await db.prepare(`SELECT * FROM amazon_leads WHERE job_id = ? AND (is_duplicate = 0 OR is_duplicate IS NULL) AND (email_verified = 1 OR (email IS NULL AND website IS NOT NULL)) ORDER BY email_verified DESC, id`).all(jobId);
  } else {
    leads = await db.prepare('SELECT * FROM intent_leads WHERE job_id = ? AND email_verified = 1 AND is_duplicate = 0 ORDER BY id').all(jobId);
  }
  res.json(leads);
});

// GET /api/jobs/:jobId/logs — poll for new logs since a given id
app.get('/api/jobs/:jobId/logs', async (req, res) => {
  const { jobId } = req.params;
  const since = parseInt(req.query.since || '0');
  const countOnly = req.query.countOnly === '1';

  if (countOnly) {
    const row = await db.prepare('SELECT COUNT(*) as cnt FROM job_logs WHERE job_id = ?').get(jobId);
    return res.json({ total: Number(row?.cnt || row?.c || 0) });
  }

  const logs = await db.prepare('SELECT * FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT 500').all(jobId, since);
  const job = await db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  res.json({ logs, job });
});

// POST /api/jobs/:jobId/pause
app.post('/api/jobs/:jobId/pause', async (req, res) => {
  const { jobId } = req.params;
  await db.prepare('UPDATE scrape_jobs SET is_paused=1 WHERE id=?').run(jobId);
  res.json({ ok: true });
});

// POST /api/jobs/:jobId/resume
app.post('/api/jobs/:jobId/resume', async (req, res) => {
  const { jobId } = req.params;
  await db.prepare('UPDATE scrape_jobs SET is_paused=0 WHERE id=?').run(jobId);
  res.json({ ok: true });
});

// POST /api/jobs/:jobId/restart — re-run an interrupted/errored amazon job
app.post('/api/jobs/:jobId/restart', async (req, res) => {
  const { jobId } = req.params;
  const job = await db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running') return res.json({ ok: false, error: 'Job is already running' });
  if (job.framework !== 'amazon') return res.json({ ok: false, error: 'Only Amazon jobs can be restarted' });

  // Check no other amazon job is running
  const running = await db.prepare(`SELECT id FROM scrape_jobs WHERE framework='amazon' AND status='running'`).get();
  if (running) return res.json({ ok: false, error: `Job #${running.id} is already running` });

  await db.prepare(`UPDATE scrape_jobs SET status='running', completed_at=NULL, started_at=CURRENT_TIMESTAMP WHERE id=?`).run(jobId);
  await saveLog(jobId, 'info', `🔄 Manually restarted by user`);
  setImmediate(() => runAmazonJob(jobId, job.date_from, job.date_to, job.target_leads, job.keyword));
  res.json({ ok: true });
});

// POST /api/jobs/:jobId/cancel
app.post('/api/jobs/:jobId/cancel', async (req, res) => {
  const { jobId } = req.params;
  await db.prepare("UPDATE scrape_jobs SET status='cancelled', is_paused=0 WHERE id=?").run(jobId);
  res.json({ ok: true });
});

// DELETE /api/jobs/:jobId — delete a job and its leads
app.delete('/api/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = await db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await db.prepare('DELETE FROM amazon_leads WHERE job_id = ?').run(jobId);
  await db.prepare('DELETE FROM intent_leads WHERE job_id = ?').run(jobId);
  await db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(jobId);
  await db.prepare('DELETE FROM scrape_jobs WHERE id = ?').run(jobId);
  res.json({ success: true, deleted: jobId });
});

// GET /api/export/:jobId — CSV export (verified, non-duplicate only)
app.get('/api/export/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { framework = 'amazon', verifiedOnly = 'true' } = req.query;
  // verifiedOnly=true: show verified email leads + website-only leads (both useful)
  const verifiedFilter = verifiedOnly === 'true' ? `AND is_duplicate = 0 AND (email_verified = 1 OR (email IS NULL AND website IS NOT NULL))` : '';
  const job = await db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (framework === 'amazon') {
    const leads = await db.prepare(`SELECT * FROM amazon_leads WHERE job_id = ? ${verifiedFilter} ORDER BY id`).all(jobId);

    // Split into two sheets per Suleman's requirement:
    // Sheet 1: Paperback + Hardcover (has Publisher)
    // Sheet 2: Kindle/Ebook (no Publisher)
    const printLeads = leads.filter(l => !l.book_format || l.book_format === 'Paperback' || l.book_format === 'Hardcover' || l.book_format === 'Unknown');
    const kindleLeads = leads.filter(l => l.book_format === 'Kindle');

    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();

    // Sheet 1 — Paperback & Hardcover (with Publisher)
    const printHeaders = ['#','Author','Book Title','Format','Publisher','Published','Reviews','Email','Email Confidence','Website','Amazon URL'];
    const printRows = printLeads.map((l,i) => [i+1, l.author, l.book_title, l.book_format||'Paperback', l.publisher||'', l.publish_date||'', l.review_count||0, l.email||'', l.email_confidence||'', l.website||'', l.amazon_url]);
    const ws1 = XLSX.utils.aoa_to_sheet([printHeaders, ...printRows]);
    XLSX.utils.book_append_sheet(wb, ws1, 'Paperback & Hardcover');

    // Sheet 2 — Kindle/Ebook (no Publisher)
    const kindleHeaders = ['#','Author','Book Title','Published','Reviews','Email','Email Confidence','Website','Amazon URL'];
    const kindleRows = kindleLeads.map((l,i) => [i+1, l.author, l.book_title, l.publish_date||'', l.review_count||0, l.email||'', l.email_confidence||'', l.website||'', l.amazon_url]);
    const ws2 = XLSX.utils.aoa_to_sheet([kindleHeaders, ...kindleRows]);
    XLSX.utils.book_append_sheet(wb, ws2, 'Kindle & eBook');

    const filename = `amazon_leads_${job.date_from}_to_${job.date_to}.xlsx`;
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buf);
  }

  // Intent leads — CSV as before
  const leads = await db.prepare(`SELECT * FROM intent_leads WHERE job_id = ? ${verifiedFilter} ORDER BY id`).all(jobId);
  const headers = ['#','Name','Title','Email','Email Status','Phone','WhatsApp','Budget','City','Source','URL','Posted Date','Scraped At'];
  const rows = leads.map((l,i) => [i+1, l.name||'', l.title||'', l.email||'', l.email_status||'', l.phone||'', l.whatsapp||'', l.budget||'', l.city||'', l.source||'', l.url, l.posted_date||'', l.scraped_at]);
  const csv = [headers, ...rows].map(row => row.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const filename = `intent_leads_${job.date_from}_to_${job.date_to}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// GET /api/cities
app.get('/api/cities', async (req, res) => {
  res.json({ cities: CRAIGSLIST_CITIES });
});

// GET /api/health
app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    apis: {
      brightdata: !!BRIGHTDATA_API_KEY,
      hunter: !!HUNTER_API_KEY,
      gemini: !!GEMINI_API_KEY
    }
  });
});

// GET /api/stats — dashboard summary
app.get('/api/stats', async (req, res) => {
  try {
    const vRow = await db.prepare("SELECT COUNT(*) as cnt FROM amazon_leads WHERE email_verified=1 AND email_confidence='high' AND is_duplicate=0").get();
    const wRow = await db.prepare('SELECT COUNT(*) as cnt FROM amazon_leads WHERE website IS NOT NULL AND is_duplicate=0').get();
    const jRow = await db.prepare("SELECT COUNT(*) as cnt FROM scrape_jobs WHERE framework='amazon'").get();
    const verified = Number(vRow?.cnt || vRow?.c || 0);
    const websites = Number(wRow?.cnt || wRow?.c || 0);
    const jobs = Number(jRow?.cnt || jRow?.c || 0);
    res.json({ verified, websites, jobs });
  } catch(e) {
    res.json({ verified: 0, websites: 0, jobs: 0, error: e.message });
  }
});

// GET /api/version — returns git commit info baked at build time
app.get('/api/version', async (req, res) => {
  res.json({
    commit: process.env.RENDER_GIT_COMMIT || 'local',
    commitShort: (process.env.RENDER_GIT_COMMIT || 'local').substring(0, 7),
    branch: process.env.RENDER_GIT_BRANCH || 'master',
    deployedAt: process.env.RENDER_SERVICE_ID ? new Date().toISOString() : null,
    buildTime: BUILD_TIME
  });
});

// GET /api/debug/craigslist
app.get('/api/debug/craigslist', async (req, res) => {
  const logs = [];
  const sendEvent = (type, data) => logs.push({ type, ...data });

  try {
    const results = await scrapeCraigslistCity('sfbay', '', sendEvent);
    res.json({
      success: true,
      results: results.length,
      sampleTitles: results.slice(0, 5).map(r => r.title),
      logs
    });
  } catch (error) {
    res.json({ success: false, error: error.message, logs });
  }
});

// ============================================================
// CORE AMAZON SCRAPE RUNNER — called by POST and auto-resume
// ============================================================
async function runAmazonJob(jobId, dateFrom, dateTo, targetLeads, keyword) {
    // Local sendEvent writes logs to DB instead of SSE
    const sendEvent = async (type, data) => {
      if (type === 'log') {
        await saveLog(jobId, data.level || 'info', data.message || '');
      }
      // progress/lead/complete are handled via DB updates — no action needed
    };

    // Resume from existing counts + position (in case of server restart)
    const existingCounts = await db.prepare('SELECT verified_count, total_count, resume_url_index, resume_page FROM scrape_jobs WHERE id=?').get(jobId);
    // Always read actual counts from DB rows — job counter can drift on restart
    const actualVerified = await db.prepare("SELECT COUNT(*) as cnt FROM amazon_leads WHERE job_id=? AND email_verified=1 AND email_confidence='high' AND is_duplicate=0").get(jobId);
    const actualTotal = await db.prepare('SELECT COUNT(*) as cnt FROM amazon_leads WHERE job_id=?').get(jobId);
    let verifiedCount = Number(actualVerified?.cnt || actualVerified?.c || existingCounts?.verified_count || 0);
    let totalCount = Number(actualTotal?.cnt || actualTotal?.c || existingCounts?.total_count || 0);
    // Sync job record to match reality
    await db.prepare('UPDATE scrape_jobs SET verified_count=?, total_count=? WHERE id=?').run(verifiedCount, totalCount, jobId);

    try {
      const resuming = verifiedCount > 0;
      await saveLog(jobId, 'info', `🚀 ${resuming ? 'Resuming' : 'Starting'} Amazon Author Lead Gen (job #${jobId}, target: ${targetLeads}, already verified: ${verifiedCount})...`);

      let page_num = existingCounts?.resume_page || 1;
      const maxPages = MAX_PAGES_PER_URL;
      let keepGoing = true;
      let consecutiveEmpty = 0;
      let urlIndex = existingCounts?.resume_url_index || 0;
      const seenAsinsThisRun = new Set();
      const seenDomainsThisRun = new Set(); // skip duplicate domains (same author, multiple books)
      let cycleStartCount = verifiedCount; // track leads per full cycle to detect exhaustion
      if (resuming) await saveLog(jobId, 'info', `📍 Resuming from format ${urlIndex + 1}/${ADV_FORMAT_CODES.length}, page ${page_num}`);
      const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const fromMonth = parseInt((dateFrom||'').split('-')[1]||1), fromYear = parseInt((dateFrom||'').split('-')[0]||2026);
      const toMonth   = parseInt((dateTo||'').split('-')[1]||1),   toYear   = parseInt((dateTo||'').split('-')[0]||2026);
      await saveLog(jobId, 'info', `📚 Amazon Advanced Search: ${monthNames[fromMonth]} ${fromYear} → ${monthNames[toMonth]} ${toYear} | Formats: Paperback, Hardcover, Kindle`);

      try {
        await saveLog(jobId, 'info', `🚀 Amazon scraper using Web Unlocker (no browser needed)...`);

        // Scrape Amazon page — direct HTTP first (FREE), fallback to Bright Data only if blocked
        const AMAZON_HEADERS = [
          { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
          { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
          { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0', 'Accept-Language': 'en-US,en;q=0.5', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
          { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
        ];
        let headerIdx = 0;

        // Build list of (month, year, formatIndex) combinations to iterate
        // e.g. Jan 2025 × Paperback, Jan 2025 × Hardcover, Jan 2025 × Kindle, Feb 2025 × Paperback ...
        function buildMonthList(from, to) {
          const list = [];
          let y = parseInt(from.split('-')[0]), m = parseInt(from.split('-')[1]);
          const toY = parseInt(to.split('-')[0]), toM = parseInt(to.split('-')[1]);
          while (y < toY || (y === toY && m <= toM)) {
            for (let fi = 0; fi < ADV_FORMAT_CODES.length; fi++) {
              list.push({ year: y, month: m, formatIndex: fi });
            }
            m++; if (m > 12) { m = 1; y++; }
          }
          return list;
        }
        const monthList = buildMonthList(dateFrom, dateTo);
        const totalSlots = monthList.length;
        await saveLog(jobId, 'info', `📅 Total search slots: ${totalSlots} (${Math.ceil(totalSlots/3)} months × 3 formats)`);

        while (keepGoing) {
          // When we reach the end of Amazon pages for current slot, move to next slot
          if (page_num > maxPages) {
            urlIndex++;
            page_num = 1;
            consecutiveEmpty = 0;
            if (urlIndex >= totalSlots) {
              // Completed all month/format combinations
              const newLeadsThisCycle = verifiedCount - (cycleStartCount || 0);
              if (newLeadsThisCycle === 0) {
                keepGoing = false;
                await saveLog(jobId, 'warning', `⚠️ No more verified leads available in this date range. Found ${verifiedCount}/${targetLeads} leads total.`);
                break;
              }
              cycleStartCount = verifiedCount;
              urlIndex = 0;
              await saveLog(jobId, 'info', `🔄 Completed all slots — found ${newLeadsThisCycle} new leads this cycle. Restarting...`);
              seenAsinsThisRun.clear();
            } else {
              const slot = monthList[urlIndex];
              const fmtName = ['Paperback','Hardcover','Kindle'][slot.formatIndex];
              const mName = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][slot.month];
              await saveLog(jobId, 'info', `📂 Moving to slot ${urlIndex+1}/${totalSlots}: ${mName} ${slot.year} — ${fmtName}`);
            }
          }

          const slot = monthList[Math.min(urlIndex, totalSlots - 1)];
          // Override dateFrom for getAmazonUrl to use current slot's month/year
          const slotDateFrom = `${slot.year}-${String(slot.month).padStart(2,'0')}-01`;
          const fmtName = ['Paperback','Hardcover','Kindle'][slot.formatIndex];
          const mName = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][slot.month];

          const pageBatch = Array.from({length: 20}, (_, i) => page_num + i).filter(p => p <= maxPages);
          await saveLog(jobId, 'info', `📄 [${mName} ${slot.year} / ${fmtName}] pages ${pageBatch.join(',')}...`);

          // Override scrapeOnePage to use slot URL
          async function scrapeOnePageSlot(pageNum) {
            const pgUrl = getAmazonUrl(slot.formatIndex, pageNum, '', slotDateFrom, slotDateFrom);
            try {
              const headers = AMAZON_HEADERS[headerIdx % AMAZON_HEADERS.length];
              headerIdx++;
              const resp = await axios.get(pgUrl, { headers, timeout: 15000, maxRedirects: 3 });
              const html = resp.data;
              if (html && html.includes('a-size-medium') && !html.includes('To discuss automated access')) {
                const books = parseAmazonNewReleasesHtml(html);
                if (books.length > 0) return books;
              }
              await saveLog(jobId, 'info', `🔄 Direct blocked, using BD for page ${pageNum}...`);
              const bdHtml = await scrapeWithBrightData(pgUrl, jobId);
              if (!bdHtml) return [];
              return parseAmazonNewReleasesHtml(bdHtml);
            } catch(e) {
              await saveLog(jobId, 'warning', `⚠️ Page fetch error: ${e.message}`);
              return [];
            }
          }

          const batchResults = await Promise.all(pageBatch.map(p => scrapeOnePageSlot(p)));
          page_num += 20;

          // Save resume position after every batch
          await db.prepare('UPDATE scrape_jobs SET resume_url_index=?, resume_page=? WHERE id=?').run(urlIndex, page_num, jobId);

          const pageBooks = batchResults.flat();
          await saveLog(jobId, 'info', `📚 Got ${pageBooks.length} books from ${pageBatch.length} pages`);
          if (pageBooks.length === 0) { consecutiveEmpty++; if(consecutiveEmpty>=3) { page_num = maxPages + 1; } continue; }
          consecutiveEmpty = 0;

          // Early exit optimization: Amazon sorts newest first
          // If ALL books with dates in this batch are OLDER than dateFrom, skip rest of category
          function parseYM(dateStr) {
            if (!dateStr) return null;
            const s = dateStr.trim();
            if (/^\d{4}-\d{2}/.test(s)) return s.substring(0, 7);
            const mdy = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
            if (mdy) {
              const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
              const mon = months[mdy[1].toLowerCase().substring(0,3)];
              return mon ? `${mdy[3]}-${mon}` : null;
            }
            const my = s.match(/^(\w+)\s+(\d{4})$/);
            if (my) {
              const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
              const mon = months[my[1].toLowerCase().substring(0,3)];
              return mon ? `${my[2]}-${mon}` : null;
            }
            return null;
          }
          const fromYM = dateFrom.substring(0, 7);
          const datedBooks = pageBooks.filter(b => b.publishDate && parseYM(b.publishDate));
          // Skip to next category if majority of dated books are before our range
          // (allows some undated books without blocking the skip)
          const beforeRange = datedBooks.filter(b => parseYM(b.publishDate) < fromYM);
          if (datedBooks.length >= 10 && beforeRange.length >= datedBooks.length * 0.8) {
            await saveLog(jobId, 'info', `⏭️ ${beforeRange.length}/${datedBooks.length} books older than ${dateFrom} — skipping to next category`);
            page_num = maxPages + 1; // jump to next category
            continue;
          }

          // Concurrency pool — keep CONCURRENCY slots busy
          const CONCURRENCY = 150;
          await saveLog(jobId, 'info', `⚡ Processing ${pageBooks.length} authors with ${CONCURRENCY} concurrent workers...`);

          // Filter out already-seen ASINs (current run in-memory + DB for this job only)
          const newBooks = [];
          for (const book of pageBooks) {
            if (seenAsinsThisRun.has(book.asin)) continue;
            const exists = await db.prepare('SELECT id FROM amazon_leads WHERE asin = ? AND job_id = ?').get(book.asin, jobId);
            if (exists) { seenAsinsThisRun.add(book.asin); continue; }
            seenAsinsThisRun.add(book.asin);
            newBooks.push(book);
          }

          // If all books on this batch were repeats, Amazon is cycling — move to next loop
          if (newBooks.length === 0 && pageBooks.length > 0) {
            consecutiveEmpty++;
            await saveLog(jobId, 'info', `⏭️ All books already seen on pages ${page_num-3}-${page_num} — Amazon cycling`);
          }

          // Run with concurrency pool
          let bookIndex = 0;
          await new Promise((resolveAll) => {
            let active = 0;
            let done = 0;

            function startNext() {
              while (active < CONCURRENCY && bookIndex < newBooks.length && verifiedCount < targetLeads) {
                const book = newBooks[bookIndex++];
                active++;
                processBook(book).then(() => {
                  active--;
                  done++;
                  if (done >= newBooks.length || verifiedCount >= targetLeads) resolveAll();
                  else startNext();
                });
              }
              if (active === 0) resolveAll();
            }
            startNext();
          });

          async function processBook(book) {
            if (verifiedCount >= targetLeads) return;

            const jobStatus = await db.prepare('SELECT status, is_paused FROM scrape_jobs WHERE id=?').get(jobId);
            if (jobStatus?.status === 'cancelled') return;
            while (jobStatus && await db.prepare('SELECT is_paused FROM scrape_jobs WHERE id=?').get(jobId)?.is_paused) {
              await new Promise(r => setTimeout(r, 3000));
            }

            const title = book.title || 'Unknown Title';
            const author = book.author || 'Unknown';
            const asin = book.asin;
            const amazonUrl = `https://www.amazon.com/dp/${asin}`;

            // Skip unknown authors — can't find contact info for them
            if (!author || author === 'Unknown' || author.trim().length < 3) {
              await saveLog(jobId, 'info', `⏭️ SKIP (unknown author): ${title.substring(0, 50)}`);
              return;
            }

            // Skip fake/publisher pen names — no real person to contact
            // Signals: ends in Press/Books/Publishing/Studio/Media/Planners/Designs/Systems/Solutions
            // OR has no spaces (single word that looks like a brand, not a name)
            const authorWords = author.trim().split(/\s+/);
            const lastWord = authorWords[authorWords.length - 1].toLowerCase();
            const publisherKeywords = ['press','books','publishing','publishers','publications','studio','studios','media','planners','planner','designs','systems','solutions','collective','group','hub','inc','llc','ltd','co.','corp','academy','institute','network','digital','creative','creatives','productions','records','works','workshop','workshops','editions','edition','ink','arts','entertainment','ventures','labs','co','brand','brands','house'];
            if (publisherKeywords.includes(lastWord)) {
              await saveLog(jobId, 'info', `⏭️ SKIP (publisher/brand name): ${author}`);
              return;
            }
            // Also skip if name has no vowels or looks like a keyword slug
            if (!/[aeiou]/i.test(author)) {
              await saveLog(jobId, 'info', `⏭️ SKIP (non-person name): ${author}`);
              return;
            }

            // English-only filter — skip any non-English book
            const nonEnglishPatterns = [
              /\(French Edition\)/i, /\(Spanish Edition\)/i, /\(German Edition\)/i,
              /\(Portuguese Edition\)/i, /\(Italian Edition\)/i, /\(Dutch Edition\)/i,
              /\(Japanese Edition\)/i, /\(Korean Edition\)/i, /\(Chinese Edition\)/i,
              /\(Arabic Edition\)/i, /\(Russian Edition\)/i, /\(Turkish Edition\)/i,
              /\(Polish Edition\)/i, /\(Swedish Edition\)/i, /\(Norwegian Edition\)/i,
              / Edición /i, / édition /i, / Ausgabe /i, /\bEdição\b/i,
              /\bEdizione\b/i, /\bUitgave\b/i,
            ];
            const hasNonEnglishTag = nonEnglishPatterns.some(p => p.test(title));
            // Also detect non-ASCII characters in title (Japanese, Chinese, Arabic, Cyrillic etc)
            const hasNonAsciiChars = /[^\x00-\x7F]/.test(title) && !/[àáâãäåæçèéêëìíîïðñòóôõöùúûüýþÿ]/i.test(title);
            // Allow common accented Latin chars (English/Irish names) but block CJK, Arabic, Cyrillic
            const hasCJKOrArabic = /[\u0600-\u06FF\u0750-\u077F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF]/.test(title);
            const isNonEnglish = hasNonEnglishTag || hasCJKOrArabic;

            if (isNonEnglish) {
              await saveLog(jobId, 'info', `⏭️ SKIP (non-English): ${title.substring(0, 60)}`);
              return;
            }

            // Format filter — skip Audiobook-only listings (no use for book publishing services)
            if (book.bookFormat === 'Audiobook') {
              await saveLog(jobId, 'info', `⏭️ SKIP (audiobook only): ${title.substring(0, 60)}`);
              return;
            }

            // Review filter — skip books with more than 5 reviews (Suleman's requirement)
            const MAX_REVIEWS = 5;
            if (book.reviewCount > MAX_REVIEWS) {
              await saveLog(jobId, 'info', `⏭️ SKIP (${book.reviewCount} reviews > ${MAX_REVIEWS}): ${title.substring(0, 50)}`);
              return;
            }

            // Date range filter — only process books published within the user's selected range
            // If no publish date found from Amazon listing, check Google Books for accurate date
            let resolvedDate = book.publishDate;
            if (!resolvedDate) {
              // Try Google Books to get the date before filtering
              try {
                const gbCheck = await axios.get(
                  `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title.substring(0,50))}+inauthor:${encodeURIComponent(author)}&maxResults=1`,
                  { timeout: 5000 }
                ).catch(() => null);
                const volInfo = gbCheck?.data?.items?.[0]?.volumeInfo;
                if (volInfo?.publishedDate) {
                  resolvedDate = volInfo.publishedDate;
                  book.publishDate = resolvedDate;
                  if (volInfo.publisher) book.publisher = volInfo.publisher.substring(0, 60);
                }
              } catch(e) {}
            }

            if (resolvedDate) {
              // Parse date safely without timezone shift issues
              // Normalize to YYYY-MM-DD format first
              function parseToYMD(dateStr) {
                if (!dateStr) return null;
                const s = dateStr.trim();
                // Already YYYY-MM-DD or YYYY-MM
                if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s.substring(0, 7); // just YYYY-MM
                // "Jan 9, 2026" or "January 9, 2026"
                const mdy = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
                if (mdy) {
                  const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
                  const mon = months[mdy[1].toLowerCase().substring(0,3)];
                  if (mon) return `${mdy[3]}-${mon}-${mdy[2].padStart(2,'0')}`;
                }
                // "Jan 2026" — just month/year
                const my = s.match(/^(\w+)\s+(\d{4})$/);
                if (my) {
                  const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
                  const mon = months[my[1].toLowerCase().substring(0,3)];
                  if (mon) return `${my[2]}-${mon}`;
                }
                return null;
              }

              const pubYM = parseToYMD(resolvedDate);
              const fromYM = dateFrom.substring(0, 7); // YYYY-MM
              const toYM = dateTo.substring(0, 7);

              if (pubYM) {
                if (pubYM < fromYM) {
                  await saveLog(jobId, 'info', `⏭️ SKIP (published ${resolvedDate} — before range): ${title.substring(0, 50)}`);
                  return;
                }
                if (pubYM > toYM) {
                  await saveLog(jobId, 'info', `⏭️ SKIP (published ${resolvedDate} — after range / pre-order): ${title.substring(0, 50)}`);
                  return;
                }
              }
            } else {
              // No date found anywhere — skip to avoid wrong-date leads
              await saveLog(jobId, 'info', `⏭️ SKIP (no publish date found): ${title.substring(0, 50)}`);
              return;
            }

            // ASIN dedup — skip if already in DB for this job
            const asinExists = await db.prepare('SELECT id FROM amazon_leads WHERE asin = ? AND job_id = ?').get(asin, jobId);
            if (asinExists) {
              await saveLog(jobId, 'info', `⏭️ SKIP (seen ASIN): ${asin}`);
              return;
            }

            // Author dedup — skip if we already found this author in any job
            const authorExists = await db.prepare('SELECT id FROM amazon_leads WHERE author = ? AND email IS NOT NULL').get(author);
            if (authorExists) {
              await saveLog(jobId, 'info', `⏭️ SKIP (author already processed): ${author}`);
              return;
            }

            await saveLog(jobId, 'info', `📚 Processing: "${title}" by ${author} (${book.reviewCount || 0} reviews)`);

            // Find author contact
            const { email, website } = await findAuthorContact(author, title, async (level, msg) => await saveLog(jobId, level, msg), jobId);

            // Domain dedup — skip if same domain already scraped this run
            if (website) {
              try {
                const domain = new URL(website).hostname.replace(/^www\./, '');
                if (seenDomainsThisRun.has(domain)) {
                  await saveLog(jobId, 'info', `⏭️ SKIP (domain already scraped): ${domain}`);
                  return;
                }
                seenDomainsThisRun.add(domain);
              } catch(e) {}
            }

            // Website check
            const hasRealWebsite = website ? isRealAuthorWebsite(website) : false;

            // Skip entirely if no email AND no website — nothing useful to save
            if (!email && !hasRealWebsite) {
              await saveLog(jobId, 'info', `⏭️ SKIP (no email, no website): ${author}`);
              return;
            }

            // Classify email confidence + fetch Google Books in parallel
            const gbPromise = (!book.publisher || !book.publishDate)
              ? axios.get(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title.substring(0,50))}+inauthor:${encodeURIComponent(author)}&maxResults=1`, { timeout: 6000 }).catch(() => null)
              : Promise.resolve(null);

            let emailVerified = false;
            let emailStatus = null;
            let emailConfidence = null;

            if (email) {
              const emailLocal = (email.split('@')[0] || '').toLowerCase();
              const emailDomain = (email.split('@')[1] || '').toLowerCase();
              const authorNameParts = author.toLowerCase().replace(/[^a-z\s]/g,'').split(/\s+/).filter(p=>p.length>2);
              const emailOnAuthorDomain = authorNameParts.some(part => emailDomain.includes(part));
              const GENERIC_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','me.com','mac.com','aol.com','protonmail.com'];
              const isGenericDomain = GENERIC_DOMAINS.includes(emailDomain);
              const localHasAuthorName = authorNameParts.some(part => emailLocal.includes(part));

              const BUSINESS_LOCALS = ['info','support','contact','hello','hey','hi','admin','mail','enquiries','enquiry','office','team'];
              const isBusinessLocal = BUSINESS_LOCALS.includes(emailLocal);

              if (emailOnAuthorDomain || localHasAuthorName) {
                // Author's name in domain OR local part → definitely theirs → HIGH
                const status = isGenericDomain ? 'name_match' : 'author_domain';
                emailVerified = true; emailStatus = status; emailConfidence = 'high';
                await saveLog(jobId, 'success', `✅ HIGH (${status}): ${email}`);
              } else if (!isGenericDomain && isBusinessLocal) {
                // support@johnsmith.com or info@johnsmith.com — generic local but author domain
                // Could be author's business email — save as MEDIUM2 (not counted as HIGH)
                emailVerified = true; emailStatus = 'business_email'; emailConfidence = 'medium';
                await saveLog(jobId, 'info', `🟡 MEDIUM (business email on author domain): ${email}`);
              } else {
                // No name match, not on author domain — skip
                emailVerified = false; emailStatus = 'unverified'; emailConfidence = 'low';
                await saveLog(jobId, 'warning', `❌ SKIP (no name match): ${email}`);
              }
            }

            const gbResult = await gbPromise;

            // Process Google Books result
            if (gbResult?.data?.items?.[0]?.volumeInfo) {
              const v = gbResult.data.items[0].volumeInfo;
              if (!book.publisher && v.publisher) { book.publisher = v.publisher.substring(0,60); await saveLog(jobId, 'info', `🏢 ${book.publisher}`); }
              if (!book.publishDate && v.publishedDate) { book.publishDate = v.publishedDate; await saveLog(jobId, 'info', `📅 ${book.publishDate}`); }
            }

            // Hard skip if this email already exists ANYWHERE in DB
            if (email && emailVerified) {
              const emailExists = await db.prepare('SELECT id FROM amazon_leads WHERE email = ?').get(email);
              if (emailExists) {
                await saveLog(jobId, 'info', `⏭️ SKIP (email already collected): ${email}`);
                return;
              }
            }

            // Save to DB — both verified email leads AND website-only leads
            totalCount++;
            let insertResult;
            try {
              insertResult = await db.prepare(
                `INSERT INTO amazon_leads (job_id, author, book_title, publish_date, review_count, email, email_verified, email_status, email_confidence, website, amazon_url, asin, is_duplicate, is_non_english, publisher, book_format)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (job_id, asin) DO NOTHING`
              ).run(jobId, author, title, book.publishDate || null, book.reviewCount || 0, email || null, emailVerified ? 1 : 0, emailStatus, emailConfidence || null, hasRealWebsite ? website : null, amazonUrl, asin, 0, isNonEnglish ? 1 : 0, book.publisher || null, book.bookFormat || 'Paperback');
            } catch (dbErr) {
              await saveLog(jobId, 'warning', `⚠️ DB insert error: ${dbErr.message}`);
              totalCount--;
              return;
            }
            // INSERT OR IGNORE: if 0 rows changed, a concurrent worker already inserted this ASIN
            if (!insertResult || insertResult.changes === 0) {
              await saveLog(jobId, 'info', `⏭️ SKIP (race-dupe ASIN): ${asin}`);
              totalCount--;
              return;
            }

            if (emailVerified && emailConfidence === 'high') {
              // HIGH confidence only counts toward target
              verifiedCount++;
              await db.prepare('UPDATE scrape_jobs SET verified_count = ?, total_count = ? WHERE id = ?').run(verifiedCount, totalCount, jobId);
              await saveLog(jobId, 'success', `✅ VERIFIED #${verifiedCount}: ${author} | ${email}`);
            } else if (emailVerified && emailConfidence === 'medium') {
              // Medium saved but doesn't count toward target
              await db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);
            } else if (!email && hasRealWebsite) {
              // Website-only lead — useful but not counted toward target
              await db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);
              await saveLog(jobId, 'info', `🌐 WEBSITE-ONLY: ${author} | ${website}`);
            } else {
              await db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);
              await saveLog(jobId, 'info', `📝 Saved (unverified): ${author}`);
            }
          } // end processBook

          // Stop outer loop once target reached
          if (verifiedCount >= targetLeads) {
            keepGoing = false;
            await saveLog(jobId, 'success', `🎯 Target of ${targetLeads} reached — stopping.`);
          }

        }
      } catch (error) {
        await saveLog(jobId, 'error', `❌ Fatal error: ${error.message}`);
        console.error('Amazon background error:', error);
      }

      // Mark job complete
      await db.prepare(
        `UPDATE scrape_jobs SET status = 'complete', verified_count = ?, total_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(verifiedCount, totalCount, jobId);

      const completionMsg = verifiedCount >= targetLeads
        ? `\n🎯 TASK COMPLETE! ✅ ${verifiedCount} verified leads collected`
        : `\n⚠️ TASK ENDED — No more leads available in this date range. Found ${verifiedCount}/${targetLeads} verified leads.`;
      await saveLog(jobId, verifiedCount >= targetLeads ? 'success' : 'warning', completionMsg);

      // Notify via OpenClaw webhook (WhatsApp message to Fahad)
      try {
        const notifyUrl = process.env.OPENCLAW_NOTIFY_URL;
        if (notifyUrl) {
          await axios.post(notifyUrl, {
            message: `🎯 LeadGen Task #${jobId} complete!\n✅ ${verifiedCount} verified leads collected\n📊 ${totalCount} authors processed\n\nOpen the app to export: https://leadgen-pro-v2.onrender.com`
          }, { timeout: 10000 });
        }
      } catch(e) { console.error('Notify error:', e.message); }

    } catch (fatalErr) {
      console.error('Amazon background fatal:', fatalErr);
      try {
        await db.prepare(`UPDATE scrape_jobs SET status = 'error', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
        await saveLog(jobId, 'error', `❌ Fatal background error: ${fatalErr.message}`);
      } catch(e) {}
    }
}

// ============================================================
// POST /api/amazon — Amazon Author Lead Gen (background job)
// ============================================================
app.post('/api/amazon', async (req, res) => {
  const { dateFrom, dateTo, targetLeads = 1000, keyword } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  console.log(`[${new Date().toISOString()}] Amazon search: dateFrom=${dateFrom}, dateTo=${dateTo}, targetLeads=${targetLeads}`);

  // Prevent duplicate jobs — if one is already running, return that job
  const existingJob = await db.prepare(`SELECT id FROM scrape_jobs WHERE framework = 'amazon' AND status = 'running'`).get();
  if (existingJob) {
    return res.json({ jobId: existingJob.id, alreadyRunning: true });
  }

  // Create scrape job in DB
  const jobResult = await db.prepare(
    `INSERT INTO scrape_jobs (framework, date_from, date_to, keyword, target_leads, status, started_at)
     VALUES ('amazon', ?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)`
  ).run(dateFrom, dateTo, keyword || null, targetLeads);
  const jobId = jobResult.lastInsertRowid;

  // Return job ID immediately so frontend can start polling
  res.setHeader('Content-Type', 'application/json');
  res.json({ jobId });

  // Run scraping in background
  setImmediate(() => runAmazonJob(jobId, dateFrom, dateTo, targetLeads, keyword));
});

// ============================================================
// POST /api/search — Intent Leads (Craigslist + Reddit, background job)
// ============================================================
app.post('/api/search', async (req, res) => {
  const { keyword, region, dateFrom, dateTo, targetLeads = 50, sourceFilter = 'all', budgetFilter = 0 } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  console.log(`[${new Date().toISOString()}] Search: "${keyword}" | ${dateFrom} → ${dateTo} | target: ${targetLeads}`);

  // Prevent duplicate jobs — if one is already running, return that job
  const existingIntentJob = await db.prepare(`SELECT id FROM scrape_jobs WHERE framework = 'intent' AND status = 'running'`).get();
  if (existingIntentJob) {
    return res.json({ jobId: existingIntentJob.id, alreadyRunning: true });
  }

  // Create scrape job
  const jobResult = await db.prepare(
    `INSERT INTO scrape_jobs (framework, date_from, date_to, keyword, target_leads, status)
     VALUES ('intent', ?, ?, ?, ?, 'running')`
  ).run(dateFrom, dateTo, keyword || null, targetLeads);
  const jobId = jobResult.lastInsertRowid;

  // Return job ID immediately so frontend can start polling
  res.setHeader('Content-Type', 'application/json');
  res.json({ jobId });

  // Run scraping in background
  setImmediate(async () => {
    // Local sendEvent writes logs to DB
    const sendEvent = async (type, data) => {
      if (type === 'log') {
        await saveLog(jobId, data.level || 'info', data.message || '');
      }
    };

    let verifiedCount = 0;
    let totalCount = 0;

    try {
      await saveLog(jobId, 'info', `🚀 Starting Intent Lead search (job #${jobId})...`);

      let cities;
      if (!region || region === 'all') {
        cities = CRAIGSLIST_CITIES.slice(0, 50);
      } else if (region.includes(',')) {
        cities = region.split(',').map(r => r.trim()).filter(r => r);
      } else {
        cities = [region];
      }

      // Helper: process any post array through AI + Hunter + dedup
      async function processLeadPosts(posts, framework) {
        for (const post of posts) {
          if (verifiedCount >= targetLeads) break;
          const urlExists = await db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(post.url);
          if (urlExists) continue;

          const contacts = await extractContactsWithAI(post.body, post.title);
          if (budgetFilter > 0 && contacts.budget) {
            const budgetNum = parseInt((contacts.budget || '').replace(/[^0-9]/g, ''));
            if (budgetNum > 0 && budgetNum < budgetFilter) continue;
          }

          let emailVerified = false, emailStatus = null;
          if (contacts.email) {
            const v = await verifyEmail(contacts.email);
            emailVerified = v.valid; emailStatus = v.status;
          }

          let isDuplicate = 0;
          if (contacts.email && emailVerified) {
            const emailExists = await db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
            if (emailExists) isDuplicate = 1;
          }

          totalCount++;
          try {
            await db.prepare(`INSERT INTO intent_leads (job_id,name,title,description,email,email_verified,email_status,phone,whatsapp,budget,city,source,url,posted_date,is_duplicate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(jobId, contacts.name||post.author||'Unknown', post.title, contacts.description||post.title.substring(0,100), contacts.email||null, emailVerified?1:0, emailStatus, contacts.phone||null, contacts.whatsapp||null, contacts.budget||null, 'Remote', post.source, post.url, post.postedDate, isDuplicate);
          } catch(dbErr) { totalCount--; continue; }

          await db.prepare('UPDATE scrape_jobs SET total_count=? WHERE id=?').run(totalCount, jobId);

          if (emailVerified && isDuplicate === 0) {
            verifiedCount++;
            await db.prepare('UPDATE scrape_jobs SET verified_count=? WHERE id=?').run(verifiedCount, jobId);
            await saveLog(jobId, 'success', `✅ VERIFIED #${verifiedCount}: ${contacts.email} via ${post.source}`);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      const logFn = async (type, data) => { if (type === 'log') await saveLog(jobId, data.level||'info', data.message||''); };

      // ========== UPWORK ==========
      if ((sourceFilter === 'all' || sourceFilter === 'upwork') && verifiedCount < targetLeads) {
        await saveLog(jobId, 'info', `🔍 Searching Upwork...`);
        try {
          const upworkPosts = await scrapeUpwork(keyword, dateFrom, dateTo, logFn);
          await processLeadPosts(upworkPosts, 'upwork');
        } catch(e) { await saveLog(jobId, 'warning', `⚠️ Upwork failed: ${e.message}`); }
      }

      // ========== FIVERR ==========
      if ((sourceFilter === 'all' || sourceFilter === 'fiverr') && verifiedCount < targetLeads) {
        await saveLog(jobId, 'info', `🔍 Searching Fiverr...`);
        try {
          const fiverrPosts = await scrapeFiverr(keyword, logFn);
          await processLeadPosts(fiverrPosts, 'fiverr');
        } catch(e) { await saveLog(jobId, 'warning', `⚠️ Fiverr failed: ${e.message}`); }
      }

      // ========== TWITTER/X ==========
      if ((sourceFilter === 'all' || sourceFilter === 'twitter') && verifiedCount < targetLeads) {
        await saveLog(jobId, 'info', `🔍 Searching Twitter/X...`);
        try {
          const twitterPosts = await scrapeTwitter(keyword, dateFrom, dateTo, logFn);
          await processLeadPosts(twitterPosts, 'twitter');
        } catch(e) { await saveLog(jobId, 'warning', `⚠️ Twitter failed: ${e.message}`); }
      }

      // ========== FACEBOOK ==========
      if ((sourceFilter === 'all' || sourceFilter === 'facebook') && verifiedCount < targetLeads) {
        await saveLog(jobId, 'info', `🔍 Searching Facebook...`);
        try {
          const fbPosts = await scrapeFacebookGroups(keyword, logFn);
          await processLeadPosts(fbPosts, 'facebook');
        } catch(e) { await saveLog(jobId, 'warning', `⚠️ Facebook failed: ${e.message}`); }
      }

      // ========== REDDIT ==========
      if ((sourceFilter === 'all' || sourceFilter === 'reddit') && verifiedCount < targetLeads) {
        await saveLog(jobId, 'info', `🔍 Starting Reddit search for "${keyword}"...`);
        let redditPosts = [];
        try {
          redditPosts = await scrapeReddit(keyword, logFn, dateFrom, dateTo);
        } catch(e) { await saveLog(jobId, 'warning', `⚠️ Reddit failed: ${e.message}`); }

        await processLeadPosts(redditPosts, 'reddit');
      }

      // ========== CRAIGSLIST ==========
      if ((sourceFilter === 'all' || sourceFilter === 'craigslist') && verifiedCount < targetLeads) {
        await saveLog(jobId, 'info', `\n📍 Searching Craigslist (${cities.length} cities)...`);

        // Reuse a single browser for all CL work to avoid connection exhaustion
        let clBrowser = null;
        try {
          await saveLog(jobId, 'brightdata', `🌐 Opening shared Craigslist browser...`);
          clBrowser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS });
        } catch (e) {
          await saveLog(jobId, 'error', `❌ Could not connect browser: ${e.message}`);
        }

        // Helper: fetch a single CL post using shared browser (with reconnect)
        async function fetchCLPost(url) {
          // Reconnect if dropped
          if (!clBrowser || !clBrowser.isConnected()) {
            try {
              if (clBrowser) await clBrowser.close().catch(() => {});
              clBrowser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS });
              await saveLog(jobId, 'brightdata', `🔄 CL browser reconnected`);
            } catch (e) {
              await saveLog(jobId, 'error', `❌ CL reconnect failed: ${e.message}`);
              return null;
            }
          }
          const page = await clBrowser.newPage();
          page.setDefaultNavigationTimeout(30000);
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 1000));
            const html = await page.content();
            await page.close();
            return html;
          } catch (e) {
            await page.close().catch(() => {});
            return null;
          }
        }

        // Helper: scrape CL city listings using shared browser
        async function scrapeCLCity(city, kw) {
          const results = [];
          if (!clBrowser) return results;
          const page = await clBrowser.newPage();
          page.setDefaultNavigationTimeout(45000);
          let apiItems = [];
          page.on('response', async (response) => {
            const u = response.url();
            if (u.includes('sapi.craigslist.org') && u.includes('postings/search/full')) {
              try {
                const json = await response.json();
                const items = json?.data?.items || [];
                if (items.length > 0 && Array.isArray(items[0]) && items[0].length >= 10) {
                  apiItems = items;
                }
              } catch(e) {}
            }
          });
          const searchUrl = kw
            ? `https://${city}.craigslist.org/search/ggg?query=${encodeURIComponent(kw)}`
            : `https://${city}.craigslist.org/search/ggg`;
          try {
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
            for (let i = 0; i < 10 && apiItems.length === 0; i++) {
              await new Promise(r => setTimeout(r, 500));
            }
            for (const item of apiItems) {
              if (Array.isArray(item) && item.length >= 10) {
                const postingId = item[0];
                const title = item[item.length - 1];
                const slugArr = item.find(el => Array.isArray(el) && el[0] === 6);
                const urlSlug = slugArr ? slugArr[1] : 'gig';
                if (title && typeof title === 'string' && title.length > 5) {
                  results.push({
                    url: `https://${city}.craigslist.org/ggg/d/${urlSlug}/${postingId}.html`,
                    title, city
                  });
                }
              }
            }
            await saveLog(jobId, 'success', `✅ ${city}: ${results.length} gigs`);
          } catch (e) {
            await saveLog(jobId, 'error', `❌ ${city}: ${e.message}`);
          } finally {
            await page.close().catch(() => {});
          }
          return results;
        }

        for (const city of cities) {
          if (verifiedCount >= targetLeads) break;

          try {
            const listings = await scrapeCLCity(city, keyword);
            await saveLog(jobId, 'info', `📊 ${city}: ${listings.length} listings`);

            for (const listing of listings.slice(0, 20)) {
              if (verifiedCount >= targetLeads) break;

              // URL dedup
              const urlExists = await db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(listing.url);
              if (urlExists) {
                await saveLog(jobId, 'info', `⏭️ SKIP (seen): ${listing.url.substring(0, 60)}`);
                continue;
              }

              totalCount++;

              // Fetch full post using shared browser
              await saveLog(jobId, 'info', `🔍 Fetching: ${listing.title.substring(0, 50)}...`);
              let contacts = {};
              let postBody = '';
              let postFetched = false;
              try {
                const postHtml = await fetchCLPost(listing.url);
                if (postHtml) {
                  const { body } = parseCraigslistPost(postHtml);
                  if (body && body.length > 20) {
                    postBody = body;
                    contacts = await extractContactsWithAI(body, listing.title);
                    await saveLog(jobId, 'ai', `🧠 Email="${contacts.email || 'N/A'}", Phone="${contacts.phone || 'N/A'}"`);
                    postFetched = true;
                  }
                }
              } catch (fetchErr) {
                await saveLog(jobId, 'warning', `⚠️ Post fetch failed: ${fetchErr.message}`);
              }
              if (!postFetched) {
                totalCount--;
                continue;
              }

              // CL hides emails behind relay system — if no email from AI,
              // try to find website in post body and do Hunter domain search
              if (!contacts.email && postBody) {
                const website = extractWebsiteFromText(postBody);
                if (website) {
                  try {
                    const domain = new URL(website).hostname.replace(/^www\./, '');
                    await saveLog(jobId, 'hunter', `🔍 Hunter domain search: ${domain}`);
                    const domainEmail = await findEmailByDomain(domain);
                    if (domainEmail) {
                      contacts.email = domainEmail;
                      contacts.website = website;
                      await saveLog(jobId, 'success', `📧 Hunter found: ${domainEmail}`);
                    }
                  } catch(e) {}
                }
              }

              // Budget filter
              if (budgetFilter > 0 && contacts.budget) {
                const budgetNum = parseInt(contacts.budget.replace(/[^0-9]/g, ''));
                if (budgetNum > 0 && budgetNum < budgetFilter) {
                  await saveLog(jobId, 'reject', `❌ REJECTED: Budget $${budgetNum} < $${budgetFilter}`);
                  totalCount--;
                  continue;
                }
              }

              // Verify email
              let emailVerified = false;
              let emailStatus = null;
              if (contacts.email) {
                await saveLog(jobId, 'hunter', `📧 HUNTER.IO: Verifying ${contacts.email}...`);
                const verification = await verifyEmail(contacts.email);
                emailVerified = verification.valid;
                emailStatus = verification.status;
                await saveLog(jobId, emailVerified ? 'success' : 'warning', `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}`);
              }

              // Cross-job email dedup
              let isDuplicate = 0;
              if (contacts.email && emailVerified) {
                const emailExists = await db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
                if (emailExists) {
                  isDuplicate = 1;
                  await saveLog(jobId, 'warning', `♻️ DUPLICATE email: ${contacts.email}`);
                }
              }

              // Save to DB
              try {
                await db.prepare(
                  `INSERT INTO intent_leads (job_id, name, title, description, email, email_verified, email_status, phone, whatsapp, budget, city, source, url, posted_date, is_duplicate)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                  jobId,
                  contacts.name || 'Craigslist Poster',
                  listing.title,
                  contacts.description || listing.title,
                  contacts.email || null,
                  emailVerified ? 1 : 0,
                  emailStatus,
                  contacts.phone || null,
                  contacts.whatsapp || null,
                  contacts.budget || listing.price || null,
                  city, 'craigslist', listing.url, new Date().toISOString(), isDuplicate
                );
              } catch (dbErr) {
                await saveLog(jobId, 'warning', `⚠️ DB insert skipped (dupe URL)`);
                totalCount--;
                continue;
              }

              await db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);

              // Count + emit only verified non-duplicate leads
              if (emailVerified && isDuplicate === 0) {
                verifiedCount++;
                await db.prepare('UPDATE scrape_jobs SET verified_count = ? WHERE id = ?').run(verifiedCount, jobId);
                await saveLog(jobId, 'success', `✅ VERIFIED LEAD #${verifiedCount}: ${contacts.name || 'Craigslist Poster'} | ${contacts.email}`);
              }

              await new Promise(r => setTimeout(r, 500));
            }

          } catch (error) {
            await saveLog(jobId, 'error', `❌ ${city}: ${error.message}`);
          }
          await new Promise(r => setTimeout(r, 500));
        }

        if (clBrowser) await clBrowser.close().catch(() => {});
      }

      // Mark job complete
      await db.prepare(
        `UPDATE scrape_jobs SET status = 'complete', verified_count = ?, total_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(verifiedCount, totalCount, jobId);

      await saveLog(jobId, 'success', `\n🎯 SEARCH COMPLETE! Verified: ${verifiedCount} / ${targetLeads} | Total processed: ${totalCount}`);

    } catch (fatalErr) {
      console.error('Search background fatal:', fatalErr);
      try {
        await db.prepare(`UPDATE scrape_jobs SET status = 'error', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
        await saveLog(jobId, 'error', `❌ Fatal background error: ${fatalErr.message}`);
      } catch(e) {}
    }
  });
});

// ============================================================
const PORT = process.env.PORT || 3000;

// Async startup — init DB schema, auto-resume interrupted jobs, then start server
(async () => {
  try {
    await db.init();

    // Migrations — run on both SQLite and PG to add any missing columns
    const addColSafe = async (sql) => { try { await db.exec(sql); } catch(e) { /* column already exists */ } };
    if (db._pg) {
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS resume_url_index INTEGER DEFAULT 0");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS resume_page INTEGER DEFAULT 1");
      await addColSafe("ALTER TABLE amazon_leads ADD COLUMN IF NOT EXISTS is_non_english INTEGER DEFAULT 0");
      await addColSafe("ALTER TABLE amazon_leads ADD COLUMN IF NOT EXISTS publisher TEXT");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS bd_calls INTEGER DEFAULT 0");
      await addColSafe("ALTER TABLE amazon_leads ADD COLUMN IF NOT EXISTS book_format TEXT DEFAULT 'Paperback'");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS started_at TEXT");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS hunter_calls INTEGER DEFAULT 0");
    } else {
      // SQLite doesn't support IF NOT EXISTS on ALTER TABLE — use try/catch per column
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN resume_url_index INTEGER DEFAULT 0");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN resume_page INTEGER DEFAULT 1");
      await addColSafe("ALTER TABLE amazon_leads ADD COLUMN is_non_english INTEGER DEFAULT 0");
      await addColSafe("ALTER TABLE amazon_leads ADD COLUMN publisher TEXT");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN bd_calls INTEGER DEFAULT 0");
      await addColSafe("ALTER TABLE amazon_leads ADD COLUMN book_format TEXT DEFAULT 'Paperback'");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN started_at TEXT");
      await addColSafe("ALTER TABLE scrape_jobs ADD COLUMN hunter_calls INTEGER DEFAULT 0");
    }

    // Migrate ASIN unique constraint from global → per-job
    try {
      // Drop old global unique constraint (may be named differently on PG vs SQLite)
      await db.exec("ALTER TABLE amazon_leads DROP CONSTRAINT IF EXISTS amazon_leads_asin_key");
    } catch(e) {}
    try {
      await db.exec("DROP INDEX IF EXISTS idx_amazon_asin");
    } catch(e) {}
    try {
      // Add per-job unique constraint
      await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_job_asin ON amazon_leads(job_id, asin)");
    } catch(e) { console.warn('Index migration warning:', e.message); }

    // Find jobs that were running when server last died
    const staleJobs = await db.prepare(`SELECT * FROM scrape_jobs WHERE status = 'running'`).all();

    if (staleJobs.length > 0) {
      console.log(`🔄 Found ${staleJobs.length} interrupted job(s) — will auto-resume after server starts`);
      // Mark as interrupted first so UI shows the right status while server boots
      await db.exec("UPDATE scrape_jobs SET status='interrupted' WHERE status='running'");
    } else {
      console.log('✅ No stale jobs found');
    }

    app.listen(PORT, () => {
      console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
      console.log(`🔑 APIs: Bright Data ✅ | Hunter ✅ | Gemini ✅`);

      // Auto-resume interrupted amazon jobs — wait 15s for Neon to fully connect
      setTimeout(async () => {
        try {
          const interrupted = await db.prepare(`SELECT * FROM scrape_jobs WHERE status = 'interrupted' AND framework = 'amazon' ORDER BY id DESC`).all();
          for (const job of interrupted) {
            console.log(`🔄 Auto-resuming job #${job.id}...`);
            await db.prepare(`UPDATE scrape_jobs SET status='running', completed_at=NULL, started_at=COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id=?`).run(job.id);
            await saveLog(job.id, 'info', `🔄 Auto-resumed after server restart`);
            runAmazonJob(job.id, job.date_from, job.date_to, job.target_leads, job.keyword);
          }
          if (interrupted.length > 0) console.log(`✅ Resumed ${interrupted.length} job(s)`);
        } catch(e) {
          console.error('Auto-resume error (non-fatal):', e.message);
        }
      }, 15000);

      // Self-ping every 10 minutes to prevent Render free tier from sleeping mid-job
      const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      setInterval(async () => {
        try {
          const runningJob = await db.prepare(`SELECT id FROM scrape_jobs WHERE status='running' LIMIT 1`).get();
          if (runningJob) {
            await axios.get(`${SELF_URL}/api/ping`, { timeout: 5000 }).catch(() => {});
            console.log(`💓 Keep-alive ping sent (job #${runningJob.id} running)`);
          }
        } catch(e) {}
      }, 10 * 60 * 1000); // every 10 min

      // Turso keep-alive — ping DB every 6 hours to prevent free tier data expiry
      setInterval(async () => {
        try {
          await db.prepare('SELECT 1').get();
          console.log('💾 Turso keep-alive ping');
        } catch(e) {}
      }, 6 * 60 * 60 * 1000);
    });

  } catch(e) {
    console.log('⚠️ DB init warning:', e.message);
    app.listen(PORT, () => {
      console.log(`🚀 LeadGen Pro v2 running on port ${PORT} (DB warning: ${e.message})`);
    });
  }
})();
