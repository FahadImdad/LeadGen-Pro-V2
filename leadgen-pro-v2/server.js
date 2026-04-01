const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./db');

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
  'sacramento', 'sanjose', 'stlouis', 'pittsburgh', 'cleveland',
  'cincinnati', 'columbus', 'indianapolis', 'milwaukee', 'kansascity', 'memphis',
  'baltimore', 'richmond', 'newjersey', 'brooklyn', 'queens', 'longisland',
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

// Scrape URL using Bright Data Web Unlocker (for simple requests like Reddit JSON)
async function scrapeWithBrightData(url) {
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
      timeout: 60000,
      transformResponse: [(data) => data]
    });
    return response.data;
  } catch (error) {
    console.error('Bright Data error:', error.message);
    return null;
  }
}

// Scrape using Bright Data Browser API (with JS rendering)
async function scrapeWithBrowser(url, waitSelector = null) {
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
    } else {
      await page.waitForTimeout(2000);
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

// Verify email with Hunter.io
async function verifyEmail(email) {
  if (!email) return { valid: false };
  try {
    const response = await axios.get(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`,
      { timeout: 10000 }
    );
    const status = response.data?.data?.status;
    return {
      valid: status === 'valid' || status === 'accept_all',
      status: status
    };
  } catch (error) {
    console.error('Hunter error:', error.message);
    return { valid: false };
  }
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
    { name: 'gameDevJobs', type: 'gig', searchType: 'new' }
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

      const response = await axios.get(url, {
        headers: { 'User-Agent': 'LeadGen/2.0' },
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
  'microsoft.', 'cloudflare.', 'medium.', 'substack.', 'wordpress.com', 'blogger.com',
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
  'nytimes.com', 'theguardian.com', 'huffpost.com', 'buzzfeed.com'
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
  if (email.match(/\.(png|jpg|jpeg|gif|svg|webp|js|css|min\.js|ts)(@|$)/i)) return true;
  if (/^(user|admin|info|noreply|no-reply|test|example|support|help|contact|sales|hello)@/i.test(email)) return true;
  if (/\d+\.\d+\.\d+/.test(email)) return true;
  if (email.split('@')[0].length > 40) return true;
  if (BLOCKED_DOMAINS.some(d => email.toLowerCase().includes(d))) return true;
  const domain = email.split('@')[1] || '';
  if (!domain.includes('.')) return true;
  return false;
}

// Build Amazon search URL based on date range
function buildAmazonUrl(dateFrom, dateTo, page = 1) {
  // Use date-desc-rank with general new releases
  // Use 30-day filter by default for broadest coverage — we filter by date locally
  let base = 'https://www.amazon.com/s?i=stripbooks&s=date-desc-rank&rh=n%3A283155%2Cp_n_publication_date%3A1250225011';
  if (page > 1) {
    base += `&page=${page}`;
  }
  return base;
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

// Find author contact info via Google search — REAL AUTHOR WEBSITE ONLY
async function findAuthorContact(authorName, bookTitle, sendEvent) {
  const query = `"${authorName}" "${bookTitle}" author`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  function extractRealAuthorWebsiteFromHtml(html) {
    const urlRegex = /href="(https?:\/\/[^"]+)"/g;
    let match;
    while ((match = urlRegex.exec(html)) !== null) {
      const url = match[1].split('?')[0];
      if (isRealAuthorWebsite(url)) {
        return url;
      }
    }
    return null;
  }

  try {
    sendEvent('log', { level: 'brightdata', message: `🔍 Google: Searching for "${authorName}"...` });
    const html = await scrapeWithBrightData(searchUrl);
    if (!html) return { email: null, website: null };

    // Extract emails
    const rawEmails = html.match(emailRegex) || [];
    const emails = rawEmails.filter(e => !isBlockedEmail(e));
    const email = emails.length > 0 ? emails[0] : null;

    // Extract real author website only
    const website = extractRealAuthorWebsiteFromHtml(html);

    // If no email found but we have a real website, try scraping the website
    if (!email && website) {
      sendEvent('log', { level: 'info', message: `🌐 Visiting ${website} to find email...` });
      try {
        const siteHtml = await scrapeWithBrightData(website);
        if (siteHtml) {
          const siteEmails = (siteHtml.match(emailRegex) || []).filter(e => !isBlockedEmail(e));
          if (siteEmails.length > 0) {
            return { email: siteEmails[0], website };
          }
        }
      } catch (e) { /* ignore */ }
    }

    return { email, website };
  } catch (error) {
    sendEvent('log', { level: 'error', message: `❌ Contact search error: ${error.message}` });
    return { email: null, website: null };
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================

// GET /api/jobs — list all scrape jobs
app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM scrape_jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

// GET /api/export/:jobId — CSV export (verified, non-duplicate only)
app.get('/api/export/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { framework = 'amazon', verifiedOnly = 'true' } = req.query;
  const verifiedFilter = verifiedOnly === 'true' ? 'AND email_verified = 1 AND is_duplicate = 0' : '';
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  let leads, headers, rows;
  if (framework === 'amazon') {
    leads = db.prepare(`SELECT * FROM amazon_leads WHERE job_id = ? ${verifiedFilter} ORDER BY id`).all(jobId);
    headers = ['#','Author','Book Title','Published','Email','Email Status','Website','Amazon URL','Scraped At'];
    rows = leads.map((l,i) => [i+1, l.author, l.book_title, l.publish_date||'', l.email||'', l.email_status||'', l.website||'', l.amazon_url, l.scraped_at]);
  } else {
    leads = db.prepare(`SELECT * FROM intent_leads WHERE job_id = ? ${verifiedFilter} ORDER BY id`).all(jobId);
    headers = ['#','Name','Title','Email','Email Status','Phone','WhatsApp','Budget','City','Source','URL','Posted Date','Scraped At'];
    rows = leads.map((l,i) => [i+1, l.name||'', l.title||'', l.email||'', l.email_status||'', l.phone||'', l.whatsapp||'', l.budget||'', l.city||'', l.source||'', l.url, l.posted_date||'', l.scraped_at]);
  }

  const csv = [headers, ...rows].map(row => row.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const filename = `${framework}_leads_${job.date_from}_to_${job.date_to}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// GET /api/cities
app.get('/api/cities', (req, res) => {
  res.json({ cities: CRAIGSLIST_CITIES });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apis: {
      brightdata: !!BRIGHTDATA_API_KEY,
      hunter: !!HUNTER_API_KEY,
      gemini: !!GEMINI_API_KEY
    }
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
// POST /api/amazon — Amazon Author Lead Gen
// ============================================================
app.post('/api/amazon', async (req, res) => {
  const { dateFrom, dateTo, targetLeads = 1000, keyword } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  console.log(`[${new Date().toISOString()}] Amazon search: dateFrom=${dateFrom}, dateTo=${dateTo}, targetLeads=${targetLeads}`);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  // Create scrape job in DB
  const jobResult = db.prepare(
    `INSERT INTO scrape_jobs (framework, date_from, date_to, keyword, target_leads, status)
     VALUES ('amazon', ?, ?, ?, ?, 'running')`
  ).run(dateFrom, dateTo, keyword || null, targetLeads);
  const jobId = jobResult.lastInsertRowid;

  sendEvent('log', { level: 'info', message: `🚀 Starting Amazon Author Lead Gen (job #${jobId}, target: ${targetLeads} verified leads)...` });
  sendEvent('status', { message: 'Scraping Amazon new releases...', jobId });

  let verifiedCount = 0;
  let totalCount = 0;

  // Step 1: Stream Amazon books page by page using Web Unlocker (server-side rendered HTML)
  let page_num = 1;
  const maxPages = 50;
  let keepGoing = true;
  let consecutiveEmpty = 0;

  // Parse Amazon search results HTML (server-rendered)
  function parseAmazonSearchHtml(html) {
    const books = [];
    const seenAsins = new Set();

    // Strategy 1: data-asin attribute (HTML) - case insensitive, any alphanumeric
    const asinRegex = /data-asin="([a-zA-Z0-9]{8,12})"/gi;
    let match;

    while ((match = asinRegex.exec(html)) !== null) {
      const asin = match[1].toUpperCase();
      if (seenAsins.has(asin) || asin === '0000000000' || /^0+$/.test(asin)) continue;
      seenAsins.add(asin);

      // Get surrounding context ~4000 chars
      const startIdx = Math.max(0, match.index - 100);
      const chunk = html.substring(startIdx, startIdx + 4000);

      // Extract title — multiple patterns
      let title = '';
      const titlePatterns = [
        /data-cy="title-recipe"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i,
        /<h2[^>]*>[\s\S]*?<span[^>]*>([^<]{5,200})<\/span>/,
        /class="[^"]*a-size-(?:medium|base-plus)[^"]*a-color-base[^"]*a-text-normal[^"]*"[^>]*>([^<]{5,200})<\/span>/,
        /class="[^"]*a-size-medium[^"]*"[^>]*>([^<]{5,200})<\/span>/,
        /class="[^"]*a-size-base-plus[^"]*"[^>]*>([^<]{5,200})<\/span>/,
        /"title":"([^"]{5,200})"/,
      ];
      for (const pat of titlePatterns) {
        const m = chunk.match(pat);
        if (m) { title = m[1].replace(/<[^>]+>/g, '').trim(); if (title.length > 3) break; }
      }
      if (!title || title.length < 3) continue;

      // Extract author
      let author = '';
      const authorPatterns = [
        /by\s+<a[^>]*class="[^"]*a-link-normal[^"]*"[^>]*>([^<]{2,100})<\/a>/i,
        /class="[^"]*s-line-clamp[^"]*"[^>]*>[\s\S]*?by\s+([\w\s.,'-]{2,60})(?:<|$)/i,
        /"authorName":"([^"]{2,100})"/,
        /class="[^"]*a-color-secondary[^"]*"[^>]*>\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
      ];
      for (const pat of authorPatterns) {
        const m = chunk.match(pat);
        if (m) { author = m[1].replace(/<[^>]+>/g, '').trim(); if (author.length > 1) break; }
      }

      // Extract publish date
      let publishDate = '';
      const dateMatch = chunk.match(/(\w+\s+\d{1,2},?\s*\d{4})/);
      if (dateMatch) publishDate = dateMatch[1];

      books.push({ asin, title, author: author || 'Unknown', publishDate, amazonUrl: `https://www.amazon.com/dp/${asin}` });
    }

    // Strategy 2: try JSON embedded data if HTML parsing got 0
    if (books.length === 0) {
      const jsonMatch = html.match(/"asin"\s*:\s*"([a-zA-Z0-9]{8,12})"/g);
      if (jsonMatch) {
        sendEvent('log', { level: 'info', message: `🔍 Trying JSON extraction — found ${jsonMatch.length} ASIN candidates` });
        for (const m of jsonMatch) {
          const asin = m.match(/"([a-zA-Z0-9]{8,12})"/)[1].toUpperCase();
          if (!seenAsins.has(asin) && !/^0+$/.test(asin)) {
            seenAsins.add(asin);
            books.push({ asin, title: `Book ${asin}`, author: 'Unknown', publishDate: '', amazonUrl: `https://www.amazon.com/dp/${asin}` });
          }
        }
      }
    }

    return books;
  }

  try {
    while (keepGoing && page_num <= maxPages) {
      const url = buildAmazonUrl(dateFrom, dateTo, page_num);
      sendEvent('log', { level: 'info', message: `📄 Scraping Amazon page ${page_num} via Web Unlocker...` });

      let pageBooks = [];
      try {
        const html = await scrapeWithBrightData(url);
        if (!html) {
          sendEvent('log', { level: 'error', message: `❌ Page ${page_num}: No response from Web Unlocker` });
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          page_num++;
          continue;
        }

        const htmlLen = html.length;
        sendEvent('log', { level: 'info', message: `📄 Page ${page_num}: Got ${htmlLen} chars of HTML` });

        // Check for CAPTCHA
        if (html.includes('captchacharacters') || html.includes('Type the characters you see')) {
          sendEvent('log', { level: 'warning', message: `⚠️ CAPTCHA on page ${page_num} — Web Unlocker should bypass, retrying in 5s...` });
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        pageBooks = parseAmazonSearchHtml(html);
        sendEvent('log', { level: pageBooks.length > 0 ? 'success' : 'warning', message: `📚 Page ${page_num}: ${pageBooks.length} books parsed` });

        if (pageBooks.length === 0) {
          // Log snippet to see what we got
          const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 300);
          sendEvent('log', { level: 'warning', message: `⚠️ HTML snippet: ${snippet}` });
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          page_num++;
          continue;
        }
        consecutiveEmpty = 0;
      } catch (pageError) {
        sendEvent('log', { level: 'error', message: `❌ Page ${page_num} error: ${pageError.message}` });
        break;
      }

      if (pageBooks.length === 0) {
        break;
      }

      sendEvent('log', { level: 'success', message: `📚 Page ${page_num}: ${pageBooks.length} books` });
      page_num++;

      // Step 2: Process each book
      for (const book of pageBooks) {
        if (verifiedCount >= targetLeads) { keepGoing = false; break; }

        const title = book.title || 'Unknown Title';
        const author = book.author || 'Unknown Author';
        const asin = book.asin;
        const amazonUrl = `https://www.amazon.com/dp/${asin}`;

        // ASIN dedup — skip entirely if already in DB
        const asinExists = db.prepare('SELECT id FROM amazon_leads WHERE asin = ?').get(asin);
        if (asinExists) {
          sendEvent('log', { level: 'info', message: `⏭️ SKIP (seen ASIN): ${asin}` });
          continue;
        }

        sendEvent('log', { level: 'info', message: `📚 Processing: "${title}" by ${author}` });
        totalCount++;

        // Find author contact
        const { email, website } = await findAuthorContact(author, title, sendEvent);

        // Verify email
        let emailVerified = false;
        let emailStatus = null;
        if (email) {
          sendEvent('log', { level: 'hunter', message: `📧 HUNTER.IO: Verifying ${email}...` });
          const verification = await verifyEmail(email);
          emailVerified = verification.valid;
          emailStatus = verification.status;
          sendEvent('log', { level: emailVerified ? 'success' : 'warning', message: `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}` });
        }

        // Website check
        const hasRealWebsite = website ? isRealAuthorWebsite(website) : false;

        // Check for cross-job email duplicate
        let isDuplicate = 0;
        if (email && emailVerified) {
          const emailExists = db.prepare('SELECT id FROM amazon_leads WHERE email = ? AND job_id != ?').get(email, jobId);
          if (emailExists) {
            isDuplicate = 1;
            sendEvent('log', { level: 'warning', message: `♻️ DUPLICATE email across jobs: ${email} — saving but not counting` });
          }
        }

        // Save to DB regardless
        try {
          db.prepare(
            `INSERT INTO amazon_leads (job_id, author, book_title, publish_date, email, email_verified, email_status, website, amazon_url, asin, is_duplicate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(jobId, author, title, book.publishDate || null, email || null, emailVerified ? 1 : 0, emailStatus, hasRealWebsite ? website : null, amazonUrl, asin, isDuplicate);
        } catch (dbErr) {
          // UNIQUE constraint hit (race condition) — skip
          sendEvent('log', { level: 'warning', message: `⚠️ DB insert skipped (dupe): ${asin}` });
          continue;
        }

        // Only count and emit if ALL 4 checks pass:
        // 1. Email verified  2. Non-duplicate email  3. Real author website  4. ASIN not seen (already checked)
        if (emailVerified && isDuplicate === 0 && hasRealWebsite) {
          verifiedCount++;
          db.prepare('UPDATE scrape_jobs SET verified_count = ?, total_count = ? WHERE id = ?').run(verifiedCount, totalCount, jobId);

          const lead = {
            id: totalCount,
            author,
            bookTitle: title,
            publishDate: book.publishDate || '',
            email,
            emailVerified: true,
            emailStatus,
            website,
            amazonUrl,
            asin,
            scrapedAt: new Date().toISOString()
          };

          sendEvent('amazon_lead', { lead });
          sendEvent('progress', { verified: verifiedCount, target: targetLeads });
          sendEvent('log', { level: 'success', message: `✅ VERIFIED LEAD #${verifiedCount}: ${author} | ${email}` });
        } else {
          db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);
          const reason = !emailVerified ? 'no verified email' : isDuplicate ? 'duplicate email' : 'no real author website';
          sendEvent('log', { level: 'info', message: `📝 Saved to DB (not counted — ${reason}): ${author}` });
        }

        await new Promise(r => setTimeout(r, 1000));
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (error) {
    sendEvent('log', { level: 'error', message: `❌ Fatal error: ${error.message}` });
    console.error('Amazon endpoint error:', error);
  }

  // Mark job complete
  db.prepare(
    `UPDATE scrape_jobs SET status = 'complete', verified_count = ?, total_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(verifiedCount, totalCount, jobId);

  sendEvent('log', { level: 'success', message: `\n🎯 AMAZON COMPLETE! Verified: ${verifiedCount} / ${targetLeads} | Total processed: ${totalCount}` });
  sendEvent('complete', { jobId, verified: verifiedCount, total: totalCount, target: targetLeads });

  res.end();
});

// ============================================================
// POST /api/search — Intent Leads (Craigslist + Reddit)
// ============================================================
app.post('/api/search', async (req, res) => {
  const { keyword, region, dateFrom, dateTo, targetLeads = 50, sourceFilter = 'all', budgetFilter = 0 } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  console.log(`[${new Date().toISOString()}] Search: "${keyword}" | ${dateFrom} → ${dateTo} | target: ${targetLeads}`);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  // Create scrape job
  const jobResult = db.prepare(
    `INSERT INTO scrape_jobs (framework, date_from, date_to, keyword, target_leads, status)
     VALUES ('intent', ?, ?, ?, ?, 'running')`
  ).run(dateFrom, dateTo, keyword || null, targetLeads);
  const jobId = jobResult.lastInsertRowid;

  sendEvent('status', { message: 'Starting search...', jobId });

  let verifiedCount = 0;
  let totalCount = 0;

  let cities;
  if (!region || region === 'all') {
    cities = CRAIGSLIST_CITIES.slice(0, 50);
  } else if (region.includes(',')) {
    cities = region.split(',').map(r => r.trim()).filter(r => r);
  } else {
    cities = [region];
  }

  // ========== REDDIT FIRST ==========
  if (sourceFilter === 'all' || sourceFilter === 'reddit') {
    sendEvent('log', { level: 'info', message: `🔍 Starting Reddit search for "${keyword}"...` });
    sendEvent('status', { message: `Searching Reddit...` });

    const redditPosts = await scrapeReddit(keyword, sendEvent, dateFrom, dateTo);

    for (const post of redditPosts) {
      if (verifiedCount >= targetLeads) break;

      // URL dedup — skip entirely if already in DB
      const urlExists = db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(post.url);
      if (urlExists) {
        sendEvent('log', { level: 'info', message: `⏭️ SKIP (seen URL): ${post.url.substring(0, 60)}` });
        continue;
      }

      sendEvent('log', { level: 'ai', message: `🤖 AI: Analyzing "${post.title.substring(0, 50)}..."` });

      const contacts = await extractContactsWithAI(post.body, post.title);
      sendEvent('log', { level: 'ai', message: `🧠 AI Result: Email="${contacts.email || 'N/A'}", Budget="${contacts.budget || 'N/A'}"` });

      if (budgetFilter > 0 && contacts.budget) {
        const budgetNum = parseInt(contacts.budget.replace(/[^0-9]/g, ''));
        if (budgetNum > 0 && budgetNum < budgetFilter) {
          sendEvent('log', { level: 'reject', message: `❌ REJECTED: Budget $${budgetNum} < $${budgetFilter}` });
          continue;
        }
      }

      let emailVerified = false;
      let emailStatus = null;
      if (contacts.email) {
        sendEvent('log', { level: 'hunter', message: `📧 HUNTER.IO: Verifying ${contacts.email}...` });
        const verification = await verifyEmail(contacts.email);
        emailVerified = verification.valid;
        emailStatus = verification.status;
        sendEvent('log', { level: emailVerified ? 'success' : 'warning', message: `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}` });
      }

      // Check cross-job email duplicate
      let isDuplicate = 0;
      if (contacts.email && emailVerified) {
        const emailExists = db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
        if (emailExists) {
          isDuplicate = 1;
          sendEvent('log', { level: 'warning', message: `♻️ DUPLICATE email across jobs: ${contacts.email}` });
        }
      }

      totalCount++;

      // Save to DB
      try {
        db.prepare(
          `INSERT INTO intent_leads (job_id, name, title, description, email, email_verified, email_status, phone, whatsapp, budget, city, source, url, posted_date, is_duplicate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          jobId,
          contacts.name || post.author || 'Unknown',
          post.title,
          contacts.description || post.title.substring(0, 100),
          contacts.email || null,
          emailVerified ? 1 : 0,
          emailStatus,
          contacts.phone || null,
          contacts.whatsapp || null,
          contacts.budget || null,
          'Remote',
          post.source,
          post.url,
          post.postedDate,
          isDuplicate
        );
      } catch (dbErr) {
        sendEvent('log', { level: 'warning', message: `⚠️ DB insert skipped (dupe URL): ${post.url.substring(0, 60)}` });
        continue;
      }

      db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);

      // Only emit and count if verified and non-duplicate
      if (emailVerified && isDuplicate === 0) {
        verifiedCount++;
        db.prepare('UPDATE scrape_jobs SET verified_count = ? WHERE id = ?').run(verifiedCount, jobId);

        const lead = {
          id: totalCount,
          name: contacts.name || post.author || 'Unknown',
          title: post.title,
          description: contacts.description || post.title.substring(0, 100),
          email: contacts.email,
          emailVerified: true,
          emailStatus,
          phone: contacts.phone || null,
          whatsapp: contacts.whatsapp || null,
          budget: contacts.budget || null,
          city: 'Remote',
          source: post.source,
          url: post.url,
          postedDate: post.postedDate,
          scrapedAt: new Date().toISOString()
        };

        lead.contactPriority = getContactPriority(lead);
        lead.contactType = getContactType(lead.contactPriority);

        sendEvent('lead', { lead });
        sendEvent('progress', { verified: verifiedCount, target: targetLeads });
        sendEvent('log', { level: 'success', message: `✅ VERIFIED LEAD #${verifiedCount}: ${lead.name} | ${lead.email}` });
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ========== CRAIGSLIST ==========
  if ((sourceFilter === 'all' || sourceFilter === 'craigslist') && verifiedCount < targetLeads) {
    sendEvent('log', { level: 'info', message: `\n📍 Searching Craigslist (${cities.length} cities)...` });
    sendEvent('status', { message: `Searching Craigslist...` });

    for (const city of cities) {
      if (verifiedCount >= targetLeads) break;

      try {
        const listings = await scrapeCraigslistCity(city, keyword, sendEvent);

        for (const listing of listings.slice(0, 20)) {
          if (verifiedCount >= targetLeads) break;

          // URL dedup
          const urlExists = db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(listing.url);
          if (urlExists) {
            sendEvent('log', { level: 'info', message: `⏭️ SKIP (seen URL): ${listing.url.substring(0, 60)}` });
            continue;
          }

          totalCount++;

          // Fetch full post to extract contact info
          sendEvent('log', { level: 'info', message: `🔍 Fetching full post: ${listing.title.substring(0, 50)}...` });
          let contacts = {};
          try {
            const postHtml = await scrapeWithBrightData(listing.url);
            if (postHtml) {
              const { body } = parseCraigslistPost(postHtml);
              if (body) {
                sendEvent('log', { level: 'ai', message: `🤖 AI extracting contacts from post...` });
                contacts = await extractContactsWithAI(body, listing.title);
                sendEvent('log', { level: 'ai', message: `🧠 AI: Email="${contacts.email || 'N/A'}", Phone="${contacts.phone || 'N/A'}"` });
              }
            }
          } catch (fetchErr) {
            sendEvent('log', { level: 'warning', message: `⚠️ Couldn't fetch post: ${fetchErr.message}` });
          }

          // Budget filter
          if (budgetFilter > 0 && contacts.budget) {
            const budgetNum = parseInt(contacts.budget.replace(/[^0-9]/g, ''));
            if (budgetNum > 0 && budgetNum < budgetFilter) {
              sendEvent('log', { level: 'reject', message: `❌ REJECTED: Budget $${budgetNum} < $${budgetFilter}` });
              totalCount--;
              continue;
            }
          }

          // Verify email
          let emailVerified = false;
          let emailStatus = null;
          if (contacts.email) {
            sendEvent('log', { level: 'hunter', message: `📧 HUNTER.IO: Verifying ${contacts.email}...` });
            const verification = await verifyEmail(contacts.email);
            emailVerified = verification.valid;
            emailStatus = verification.status;
            sendEvent('log', { level: emailVerified ? 'success' : 'warning', message: `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}` });
          }

          // Cross-job email dedup
          let isDuplicate = 0;
          if (contacts.email && emailVerified) {
            const emailExists = db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
            if (emailExists) {
              isDuplicate = 1;
              sendEvent('log', { level: 'warning', message: `♻️ DUPLICATE email: ${contacts.email}` });
            }
          }

          // Save to DB
          try {
            db.prepare(
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
            sendEvent('log', { level: 'warning', message: `⚠️ DB insert skipped (dupe URL)` });
            totalCount--;
            continue;
          }

          db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);

          // Count + emit only verified non-duplicate leads
          if (emailVerified && isDuplicate === 0) {
            verifiedCount++;
            db.prepare('UPDATE scrape_jobs SET verified_count = ? WHERE id = ?').run(verifiedCount, jobId);

            const lead = {
              id: totalCount,
              name: contacts.name || 'Craigslist Poster',
              title: listing.title,
              description: contacts.description || listing.title,
              email: contacts.email,
              emailVerified: true,
              emailStatus,
              phone: contacts.phone || null,
              whatsapp: contacts.whatsapp || null,
              budget: contacts.budget || listing.price || null,
              city,
              source: 'craigslist',
              url: listing.url,
              postedDate: new Date().toISOString(),
              scrapedAt: new Date().toISOString()
            };
            lead.contactPriority = getContactPriority(lead);
            lead.contactType = getContactType(lead.contactPriority);

            sendEvent('lead', { lead });
            sendEvent('progress', { verified: verifiedCount, target: targetLeads });
            sendEvent('log', { level: 'success', message: `✅ VERIFIED LEAD #${verifiedCount}: ${lead.name} | ${lead.email}` });
          }

          await new Promise(r => setTimeout(r, 500));
        }

        sendEvent('log', { level: 'info', message: `📊 ${city}: ${listings.length} listings added to DB` });

      } catch (error) {
        sendEvent('log', { level: 'error', message: `❌ ${city}: ${error.message}` });
      }
    }
  }

  // Mark job complete
  db.prepare(
    `UPDATE scrape_jobs SET status = 'complete', verified_count = ?, total_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(verifiedCount, totalCount, jobId);

  sendEvent('log', { level: 'success', message: `\n🎯 SEARCH COMPLETE! Verified: ${verifiedCount} / ${targetLeads} | Total processed: ${totalCount}` });
  sendEvent('complete', {
    jobId,
    verified: verifiedCount,
    total: totalCount,
    target: targetLeads
  });

  res.end();
});

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
  console.log(`🔑 APIs: Bright Data ✅ | Hunter ✅ | Gemini ✅`);
});
