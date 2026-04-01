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
function saveLog(jobId, level, message) {
  db.prepare('INSERT INTO job_logs (job_id, level, message) VALUES (?, ?, ?)').run(jobId, level, message);
}

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
  if (email.match(/\.(png|jpg|jpeg|gif|svg|webp|js|css|min\.js|ts)(@|$)/i)) return true;
  if (/^(user|admin|info|noreply|no-reply|test|example|support|help|contact|sales|hello)@/i.test(email)) return true;
  if (/\d+\.\d+\.\d+/.test(email)) return true;
  if (email.split('@')[0].length > 40) return true;
  if (BLOCKED_DOMAINS.some(d => email.toLowerCase().includes(d))) return true;
  const domain = email.split('@')[1] || '';
  if (!domain.includes('.')) return true;
  return false;
}

// Amazon URLs — use Web Unlocker (not browser) for these pages since they return full HTML
const AMAZON_SEARCH_URLS = [
  'https://www.amazon.com/gp/new-releases/books/ref=zg_bsnr_pg_1?pg=1',
  'https://www.amazon.com/gp/new-releases/books/ref=zg_bsnr_pg_2?pg=2',
  'https://www.amazon.com/gp/new-releases/books/ref=zg_bsnr_pg_3?pg=3',
  'https://www.amazon.com/gp/new-releases/books/ref=zg_bsnr_pg_4?pg=4',
  'https://www.amazon.com/gp/new-releases/books/ref=zg_bsnr_pg_5?pg=5',
  // Best sellers by category
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/2635',      // Business
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/4736',      // Self Help
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/6',         // Health
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/486994011', // Biographies
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/22',        // Religion
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/4919',      // Parenting
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/75',        // Science
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/9',         // History
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/11232',     // Politics
  'https://www.amazon.com/best-sellers-books-Amazon/zgbs/books/2642',      // Travel
];

function buildAmazonUrl(dateFrom, dateTo, page = 1) { return null; }

function getAmazonUrl(urlIndex, page) {
  return AMAZON_SEARCH_URLS[urlIndex % AMAZON_SEARCH_URLS.length];
}

// Parse Amazon new-releases / best-seller HTML (Web Unlocker) into book objects
function parseAmazonNewReleasesHtml(html) {
  const books = [];
  const asinSet = new Set((html.match(/data-asin="([A-Z0-9]{8,12})"/g)||[]).map(m => m.match(/"([^"]+)"/)[1]));

  for (const asin of asinSet) {
    const idx = html.indexOf(`data-asin="${asin}"`);
    if (idx < 0) continue;
    const chunk = html.substring(idx, idx + 2500);

    // Title from p13n class or href slug
    const titleM = chunk.match(/p13n-sc-css-line-clamp[^"]*"[^>]*>([^<]{5,150})<\//) ||
                   chunk.match(/href="\/[^"]+\/dp\/[A-Z0-9]+"[^>]*><span[^>]*>([^<]{5,150})<\//);
    const title = titleM ? titleM[1].trim() : '';
    if (!title) continue;

    // Author from a-size-small text node between rating and price
    const authorM = chunk.match(/a-size-small">\s*([\w][\w\s.,''-]{2,50}?)\s*[\d<]/) ||
                    chunk.match(/a-link-child"[^>]*>([^<]{3,60})<\/a>/);
    const author = authorM ? authorM[1].trim() : 'Unknown';

    books.push({ asin, title, author, publishDate: '', amazonUrl: `https://www.amazon.com/dp/${asin}` });
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

// Find author contact info — all sources run in parallel with early exit
async function findAuthorContact(authorName, bookTitle, saveLog) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const firstName = authorName.split(' ')[0].toLowerCase();
  const lastName = authorName.split(' ').slice(-1)[0].toLowerCase();
  const nameSlug = authorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const nameUnderscore = authorName.toLowerCase().replace(/\s+/g, '_');

  function extractEmails(html) {
    return (html.match(emailRegex) || []).filter(e => !isBlockedEmail(e));
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
      const html = await scrapeWithBrightData(url);
      if (!html) return { email: null, website: null, html: null };
      const emails = extractEmails(html);
      const sites = extractRealWebsites(html);
      return { email: emails[0] || null, website: sites[0] || null, html };
    } catch(e) { return { email: null, website: null, html: null }; }
  }

  // ── PHASE 1: Parallel scan — 14 sources simultaneously ───────────────
  saveLog('info', `⚡ Parallel scanning 14 sources for ${authorName}...`);

  const encodedName = encodeURIComponent(authorName);

  const [
    googleR1, googleR2, googleR3, googleDirectEmail,
    bingR1, bingR2, ddgR,
    amazonBookR, amazonAuthorR,
    igR, reedsyR, grR,
    yahooR, pressR
  ] = await Promise.all([
    // Google x3
    fetchEmails(`https://www.google.com/search?q=${encodeURIComponent(`"${authorName}" author email contact`)}&num=10`),
    fetchEmails(`https://www.google.com/search?q=${encodeURIComponent(`"${authorName}" author official website`)}&num=10`),
    fetchEmails(`https://www.google.com/search?q=${encodeURIComponent(`"${authorName}" "${bookTitle}" author`)}&num=10`),
    // Google direct email — finds publicly posted emails anywhere online
    fetchEmails(`https://www.google.com/search?q=${encodeURIComponent(`"${authorName}" "@gmail.com" OR "@yahoo.com" OR "@hotmail.com" OR "@outlook.com"`)}&num=10`),
    // Bing x2
    fetchEmails(`https://www.bing.com/search?q=${encodeURIComponent(`"${authorName}" author email website contact`)}&count=10`),
    fetchEmails(`https://www.bing.com/search?q=${encodeURIComponent(`"${authorName}" "${bookTitle}" author email`)}&count=10`),
    // DuckDuckGo
    fetchEmails(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${authorName}" author email contact`)}`),
    // Amazon BOOK page — "About the Author" section has website/bio
    fetchEmails(`https://www.amazon.com/s?k=${encodeURIComponent(authorName + ' ' + bookTitle)}&i=stripbooks`),
    // Amazon author stores page
    fetchEmails(`https://www.amazon.com/stores/author/${nameSlug}`),
    // Instagram
    fetchEmails(`https://www.instagram.com/${firstName}${lastName}.author/`),
    // Reedsy
    fetchEmails(`https://reedsy.com/discovery/user/${nameSlug}`),
    // Goodreads
    fetchEmails(`https://www.goodreads.com/search?q=${encodedName}&search_type=authors`),
    // Yahoo search
    fetchEmails(`https://search.yahoo.com/search?p=${encodeURIComponent(`"${authorName}" author email website`)}`),
    // Search for press kits / media pages
    fetchEmails(`https://www.google.com/search?q=${encodeURIComponent(`"${authorName}" author "press" OR "media" OR "contact" OR "interview"`)}&num=10`),
  ]);

  // Collect any direct emails found across all sources
  const allResults = [googleR1, googleR2, googleR3, googleDirectEmail, bingR1, bingR2, ddgR, amazonBookR, amazonAuthorR, igR, reedsyR, yahooR, pressR];
  const directEmails = allResults.map(r => r?.email).filter(Boolean);
  if (directEmails.length > 0) {
    saveLog('success', `📧 Direct email found: ${directEmails[0]}`);
    return { email: directEmails[0], website: allResults.find(r=>r?.website)?.website || null };
  }

  // Collect all websites from all sources
  const allWebsites = [...allResults, grR]
    .flatMap(r => [r?.website, ...(r?.html ? extractRealWebsites(r.html) : [])])
    .filter(Boolean)
    .filter(isRealAuthorWebsite);
  const uniqueWebsites = [...new Set(allWebsites)].slice(0, 8);

  // ── PHASE 1b: Try common email patterns and verify ────────────────────
  // Many authors use predictable email patterns — try and verify instantly
  const commonPatterns = [
    `${firstName}@${firstName}${lastName}.com`,
    `${firstName}.${lastName}@gmail.com`,
    `${firstName}${lastName}@gmail.com`,
    `contact@${firstName}${lastName}.com`,
    `hello@${firstName}${lastName}.com`,
    `${firstName}@${firstName}${lastName}author.com`,
  ];
  // Only try domain-based patterns (e.g. john@johnsmith.com) — NOT gmail/yahoo/hotmail
  // because those can match any random person with the same name
  const domainPatterns = [
    `${firstName}@${firstName}${lastName}.com`,
    `contact@${firstName}${lastName}.com`,
    `hello@${firstName}${lastName}.com`,
    `info@${firstName}${lastName}.com`,
    `${firstName}@${firstName}${lastName}author.com`,
    `${firstName}.${lastName}@${firstName}${lastName}.com`,
  ].filter(e => {
    // Only use if the domain looks like a real author domain (contains their name)
    const domain = e.split('@')[1] || '';
    return domain.includes(firstName) || domain.includes(lastName);
  });

  if (domainPatterns.length > 0) {
    const patternResults = await Promise.all(
      domainPatterns.map(async email => {
        try {
          const r = await axios.get(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`, { timeout: 5000 });
          const status = r.data?.data?.status;
          // Only accept 'valid' — not 'accept_all' (accept_all = server accepts all emails, can't confirm person)
          if (status === 'valid') return { email, status };
        } catch(e) {}
        return null;
      })
    );
    const patternEmail = patternResults.find(r => r?.email);
    if (patternEmail) {
      saveLog('success', `📧 Domain pattern email verified: ${patternEmail.email}`);
      return { email: patternEmail.email, website: uniqueWebsites[0] || null };
    }
  }

  if (uniqueWebsites.length === 0) {
    saveLog('info', `⏩ No online presence found for ${authorName} — skipping`);
    return { email: null, website: null };
  }

  // ── PHASE 2: Parallel visit of all found websites ─────────────────────
  saveLog('info', `🌐 Visiting ${uniqueWebsites.length} websites in parallel...`);

  const contactPages = uniqueWebsites.flatMap(site => [
    site.replace(/\/$/, '') + '/contact',
    site.replace(/\/$/, '') + '/contact-me',
    site.replace(/\/$/, '') + '/about',
    site,
  ]).slice(0, 10);

  const pageResults = await Promise.all(contactPages.map(url => fetchEmails(url)));
  const siteEmail = pageResults.find(r => r?.email)?.email || null;
  const foundWebsite = uniqueWebsites[0];

  if (siteEmail) {
    saveLog('success', `📧 Email found on website: ${siteEmail}`);
    return { email: siteEmail, website: foundWebsite };
  }

  // ── PHASE 3: Hunter.io finder + domain search in parallel ─────────────
  if (foundWebsite && HUNTER_API_KEY) {
    saveLog('hunter', `🎯 Hunter: finder + domain search for ${authorName}...`);
    const domain = new URL(foundWebsite).hostname.replace(/^www\./, '');

    const [finderRes, domainEmail] = await Promise.all([
      axios.get(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_API_KEY}`, { timeout: 10000 }).catch(() => null),
      findEmailByDomain(domain, firstName, lastName),
    ]);

    const finderEmail = finderRes?.data?.data?.email;
    const confidence = finderRes?.data?.data?.score || 0;

    if (finderEmail && confidence >= 40) {
      saveLog('success', `📧 Hunter finder: ${finderEmail} (${confidence}%)`);
      return { email: finderEmail, website: foundWebsite };
    }
    if (domainEmail) {
      saveLog('success', `📧 Hunter domain: ${domainEmail}`);
      return { email: domainEmail, website: foundWebsite };
    }
  }

  return { email: null, website: foundWebsite };
}

// ============================================================
// API ENDPOINTS
// ============================================================

// GET /api/ping — keepalive / wake-up
app.get('/api/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

// GET /api/jobs — list all scrape jobs
app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM scrape_jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

// GET /api/jobs/:jobId/leads — fetch verified leads for display in table
app.get('/api/jobs/:jobId/leads', (req, res) => {
  const { jobId } = req.params;
  const { framework = 'amazon' } = req.query;
  let leads;
  if (framework === 'amazon') {
    leads = db.prepare('SELECT * FROM amazon_leads WHERE job_id = ? AND email_verified = 1 AND is_duplicate = 0 ORDER BY id').all(jobId);
  } else {
    leads = db.prepare('SELECT * FROM intent_leads WHERE job_id = ? AND email_verified = 1 AND is_duplicate = 0 ORDER BY id').all(jobId);
  }
  res.json(leads);
});

// GET /api/jobs/:jobId/logs — poll for new logs since a given id
app.get('/api/jobs/:jobId/logs', (req, res) => {
  const { jobId } = req.params;
  const since = parseInt(req.query.since || '0');
  const logs = db.prepare('SELECT * FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT 100').all(jobId, since);
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  res.json({ logs, job });
});

// DELETE /api/jobs/:jobId — delete a job and its leads
app.delete('/api/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  db.prepare('DELETE FROM amazon_leads WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM intent_leads WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM scrape_jobs WHERE id = ?').run(jobId);
  res.json({ success: true, deleted: jobId });
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

// GET /api/version — returns git commit info baked at build time
app.get('/api/version', (req, res) => {
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
// POST /api/amazon — Amazon Author Lead Gen (background job)
// ============================================================
app.post('/api/amazon', async (req, res) => {
  const { dateFrom, dateTo, targetLeads = 1000, keyword } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  console.log(`[${new Date().toISOString()}] Amazon search: dateFrom=${dateFrom}, dateTo=${dateTo}, targetLeads=${targetLeads}`);

  // Prevent duplicate jobs — if one is already running, return that job
  const existingJob = db.prepare(`SELECT id FROM scrape_jobs WHERE framework = 'amazon' AND status = 'running'`).get();
  if (existingJob) {
    return res.json({ jobId: existingJob.id, alreadyRunning: true });
  }

  // Create scrape job in DB
  const jobResult = db.prepare(
    `INSERT INTO scrape_jobs (framework, date_from, date_to, keyword, target_leads, status)
     VALUES ('amazon', ?, ?, ?, ?, 'running')`
  ).run(dateFrom, dateTo, keyword || null, targetLeads);
  const jobId = jobResult.lastInsertRowid;

  // Return job ID immediately so frontend can start polling
  res.setHeader('Content-Type', 'application/json');
  res.json({ jobId });

  // Run scraping in background
  setImmediate(async () => {
    // Local sendEvent writes logs to DB instead of SSE
    const sendEvent = (type, data) => {
      if (type === 'log') {
        saveLog(jobId, data.level || 'info', data.message || '');
      }
      // progress/lead/complete are handled via DB updates — no action needed
    };

    let verifiedCount = 0;
    let totalCount = 0;

    try {
      saveLog(jobId, 'info', `🚀 Starting Amazon Author Lead Gen (job #${jobId}, target: ${targetLeads} verified leads)...`);

      let page_num = 1;
      const maxPages = 20; // 20 pages per category URL
      let keepGoing = true;
      let consecutiveEmpty = 0;
      let urlIndex = 0;
      const seenAsinsThisRun = new Set();

      try {
        saveLog(jobId, 'info', `🚀 Amazon scraper using Web Unlocker (no browser needed)...`);

        // Scrape Amazon page via Web Unlocker (no browser needed — returns full HTML)
        async function scrapeOnePage(pageNum) {
          const pgUrl = getAmazonUrl(urlIndex, pageNum);
          try {
            saveLog(jobId, 'info', `🌐 Fetching: ${pgUrl.substring(30,70)}...`);
            const html = await scrapeWithBrightData(pgUrl);
            if (!html) return [];
            const books = parseAmazonNewReleasesHtml(html);
            return books;
          } catch(e) {
            saveLog(jobId, 'warning', `⚠️ Page fetch error: ${e.message}`);
            return [];
          }
        }

        while (keepGoing) {
          // When we reach the end of Amazon pages, loop back to page 1 with a fresh date offset
          if (page_num > maxPages) {
            urlIndex++;
            page_num = 1;
            consecutiveEmpty = 0;
            if (urlIndex >= AMAZON_SEARCH_URLS.length) {
              urlIndex = 0;
              saveLog(jobId, 'info', `🔄 Completed all ${AMAZON_SEARCH_URLS.length} category URLs — waiting 10min then restarting...`);
              await new Promise(r => setTimeout(r, 10 * 60 * 1000));
              seenAsinsThisRun.clear();
            } else {
              saveLog(jobId, 'info', `📂 Moving to next category URL ${urlIndex+1}/${AMAZON_SEARCH_URLS.length}...`);
            }
          }

          const pageBatch = [page_num, page_num+1, page_num+2].filter(p => p <= maxPages);
          saveLog(jobId, 'info', `📄 Category ${urlIndex+1}/${AMAZON_SEARCH_URLS.length} — pages ${pageBatch.join(',')}...`);
          const batchResults = await Promise.all(pageBatch.map(p => scrapeOnePage(p)));
          page_num += 3;
          const pageBooks = batchResults.flat();
          saveLog(jobId, 'info', `📚 Got ${pageBooks.length} books from ${pageBatch.length} pages`);
          if (pageBooks.length === 0) { consecutiveEmpty++; if(consecutiveEmpty>=3) { page_num = maxPages + 1; } continue; }
          consecutiveEmpty = 0;

          // Concurrency pool — always keep CONCURRENCY slots busy
          const CONCURRENCY = 30;
          saveLog(jobId, 'info', `⚡ Processing ${pageBooks.length} authors with ${CONCURRENCY} concurrent workers...`);

          // Filter out already-seen ASINs (both DB and current run)
          const newBooks = pageBooks.filter(book => {
            if (seenAsinsThisRun.has(book.asin)) return false;
            const exists = db.prepare('SELECT id FROM amazon_leads WHERE asin = ?').get(book.asin);
            if (exists) { seenAsinsThisRun.add(book.asin); return false; }
            seenAsinsThisRun.add(book.asin);
            return true;
          });

          // If all books on this batch were repeats, Amazon is cycling — move to next loop
          if (newBooks.length === 0 && pageBooks.length > 0) {
            consecutiveEmpty++;
            saveLog(jobId, 'info', `⏭️ All books already seen on pages ${page_num-3}-${page_num} — Amazon cycling`);
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

            const title = book.title || 'Unknown Title';
            const author = book.author || 'Unknown Author';
            const asin = book.asin;
            const amazonUrl = `https://www.amazon.com/dp/${asin}`;

            // ASIN dedup — skip entirely if already in DB
            const asinExists = db.prepare('SELECT id FROM amazon_leads WHERE asin = ?').get(asin);
            if (asinExists) {
              saveLog(jobId, 'info', `⏭️ SKIP (seen ASIN): ${asin}`);
              return;
            }

            saveLog(jobId, 'info', `📚 Processing: "${title}" by ${author}`);
            totalCount++;

            // Find author contact
            const { email, website } = await findAuthorContact(author, title, (level, msg) => saveLog(jobId, level, msg));

            // Verify email
            let emailVerified = false;
            let emailStatus = null;
            if (email) {
              saveLog(jobId, 'hunter', `📧 HUNTER.IO: Verifying ${email}...`);
              const verification = await verifyEmail(email);
              emailVerified = verification.valid;
              emailStatus = verification.status;
              saveLog(jobId, emailVerified ? 'success' : 'warning', `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}`);
            }

            // Website check
            const hasRealWebsite = website ? isRealAuthorWebsite(website) : false;

            // Check for cross-job email duplicate
            let isDuplicate = 0;
            if (email && emailVerified) {
              const emailExists = db.prepare('SELECT id FROM amazon_leads WHERE email = ? AND job_id != ?').get(email, jobId);
              if (emailExists) {
                isDuplicate = 1;
                saveLog(jobId, 'warning', `♻️ DUPLICATE email across jobs: ${email} — saving but not counting`);
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
              saveLog(jobId, 'warning', `⚠️ DB insert skipped (dupe): ${asin}`);
              return;
            }

            // Count if email verified + non-duplicate (website is nice-to-have but not required)
            if (emailVerified && isDuplicate === 0) {
              verifiedCount++;
              db.prepare('UPDATE scrape_jobs SET verified_count = ?, total_count = ? WHERE id = ?').run(verifiedCount, totalCount, jobId);
              saveLog(jobId, 'success', `✅ VERIFIED LEAD #${verifiedCount}: ${author} | ${email}`);
            } else {
              db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);
              const reason = !emailVerified ? 'no verified email' : isDuplicate ? 'duplicate email' : 'no real author website';
              saveLog(jobId, 'info', `📝 Saved (not counted — ${reason}): ${author}`);
            }
          } // end processBook

          await new Promise(r => setTimeout(r, 500));
        }
      } catch (error) {
        saveLog(jobId, 'error', `❌ Fatal error: ${error.message}`);
        console.error('Amazon background error:', error);
      }

      // Mark job complete
      db.prepare(
        `UPDATE scrape_jobs SET status = 'complete', verified_count = ?, total_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(verifiedCount, totalCount, jobId);

      saveLog(jobId, 'success', `\n🎯 AMAZON COMPLETE! Verified: ${verifiedCount} / ${targetLeads} | Total processed: ${totalCount}`);

    } catch (fatalErr) {
      console.error('Amazon background fatal:', fatalErr);
      try {
        db.prepare(`UPDATE scrape_jobs SET status = 'error', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
        saveLog(jobId, 'error', `❌ Fatal background error: ${fatalErr.message}`);
      } catch(e) {}
    }
  });
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
  const existingIntentJob = db.prepare(`SELECT id FROM scrape_jobs WHERE framework = 'intent' AND status = 'running'`).get();
  if (existingIntentJob) {
    return res.json({ jobId: existingIntentJob.id, alreadyRunning: true });
  }

  // Create scrape job
  const jobResult = db.prepare(
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
    const sendEvent = (type, data) => {
      if (type === 'log') {
        saveLog(jobId, data.level || 'info', data.message || '');
      }
    };

    let verifiedCount = 0;
    let totalCount = 0;

    try {
      saveLog(jobId, 'info', `🚀 Starting Intent Lead search (job #${jobId})...`);

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
          const urlExists = db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(post.url);
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
            const emailExists = db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
            if (emailExists) isDuplicate = 1;
          }

          totalCount++;
          try {
            db.prepare(`INSERT INTO intent_leads (job_id,name,title,description,email,email_verified,email_status,phone,whatsapp,budget,city,source,url,posted_date,is_duplicate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(jobId, contacts.name||post.author||'Unknown', post.title, contacts.description||post.title.substring(0,100), contacts.email||null, emailVerified?1:0, emailStatus, contacts.phone||null, contacts.whatsapp||null, contacts.budget||null, 'Remote', post.source, post.url, post.postedDate, isDuplicate);
          } catch(dbErr) { totalCount--; continue; }

          db.prepare('UPDATE scrape_jobs SET total_count=? WHERE id=?').run(totalCount, jobId);

          if (emailVerified && isDuplicate === 0) {
            verifiedCount++;
            db.prepare('UPDATE scrape_jobs SET verified_count=? WHERE id=?').run(verifiedCount, jobId);
            saveLog(jobId, 'success', `✅ VERIFIED #${verifiedCount}: ${contacts.email} via ${post.source}`);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // ========== UPWORK ==========
      if ((sourceFilter === 'all' || sourceFilter === 'upwork') && verifiedCount < targetLeads) {
        saveLog(jobId, 'info', `🔍 Searching Upwork...`);
        // Wrapper so scraper functions can log to DB
        const logFn = (type, data) => { if (type === 'log') saveLog(jobId, data.level||'info', data.message||''); };
        const upworkPosts = await scrapeUpwork(keyword, dateFrom, dateTo, logFn);
        await processLeadPosts(upworkPosts, 'upwork');
      }

      // ========== FIVERR ==========
      if ((sourceFilter === 'all' || sourceFilter === 'fiverr') && verifiedCount < targetLeads) {
        saveLog(jobId, 'info', `🔍 Searching Fiverr buyer requests...`);
        const logFn = (type, data) => { if (type === 'log') saveLog(jobId, data.level||'info', data.message||''); };
        const fiverrPosts = await scrapeFiverr(keyword, logFn);
        await processLeadPosts(fiverrPosts, 'fiverr');
      }

      // ========== TWITTER/X ==========
      if ((sourceFilter === 'all' || sourceFilter === 'twitter') && verifiedCount < targetLeads) {
        saveLog(jobId, 'info', `🔍 Searching Twitter/X...`);
        const logFn = (type, data) => { if (type === 'log') saveLog(jobId, data.level||'info', data.message||''); };
        const twitterPosts = await scrapeTwitter(keyword, dateFrom, dateTo, logFn);
        await processLeadPosts(twitterPosts, 'twitter');
      }

      // ========== FACEBOOK ==========
      if ((sourceFilter === 'all' || sourceFilter === 'facebook') && verifiedCount < targetLeads) {
        saveLog(jobId, 'info', `🔍 Searching Facebook Groups...`);
        const logFn = (type, data) => { if (type === 'log') saveLog(jobId, data.level||'info', data.message||''); };
        const fbPosts = await scrapeFacebookGroups(keyword, logFn);
        await processLeadPosts(fbPosts, 'facebook');
      }

      // ========== REDDIT FIRST ==========
      if (sourceFilter === 'all' || sourceFilter === 'reddit') {
        saveLog(jobId, 'info', `🔍 Starting Reddit search for "${keyword}"...`);

        const redditPosts = await scrapeReddit(keyword, sendEvent, dateFrom, dateTo);

        for (const post of redditPosts) {
          if (verifiedCount >= targetLeads) break;

          // URL dedup — skip entirely if already in DB
          const urlExists = db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(post.url);
          if (urlExists) {
            saveLog(jobId, 'info', `⏭️ SKIP (seen URL): ${post.url.substring(0, 60)}`);
            continue;
          }

          saveLog(jobId, 'ai', `🤖 AI: Analyzing "${post.title.substring(0, 50)}..."`);

          const contacts = await extractContactsWithAI(post.body, post.title);
          saveLog(jobId, 'ai', `🧠 AI Result: Email="${contacts.email || 'N/A'}", Budget="${contacts.budget || 'N/A'}"`);

          if (budgetFilter > 0 && contacts.budget) {
            const budgetNum = parseInt(contacts.budget.replace(/[^0-9]/g, ''));
            if (budgetNum > 0 && budgetNum < budgetFilter) {
              saveLog(jobId, 'reject', `❌ REJECTED: Budget $${budgetNum} < $${budgetFilter}`);
              continue;
            }
          }

          let emailVerified = false;
          let emailStatus = null;
          if (contacts.email) {
            saveLog(jobId, 'hunter', `📧 HUNTER.IO: Verifying ${contacts.email}...`);
            const verification = await verifyEmail(contacts.email);
            emailVerified = verification.valid;
            emailStatus = verification.status;
            saveLog(jobId, emailVerified ? 'success' : 'warning', `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}`);
          }

          // Check cross-job email duplicate
          let isDuplicate = 0;
          if (contacts.email && emailVerified) {
            const emailExists = db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
            if (emailExists) {
              isDuplicate = 1;
              saveLog(jobId, 'warning', `♻️ DUPLICATE email across jobs: ${contacts.email}`);
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
            saveLog(jobId, 'warning', `⚠️ DB insert skipped (dupe URL): ${post.url.substring(0, 60)}`);
            continue;
          }

          db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);

          // Only count if verified and non-duplicate
          if (emailVerified && isDuplicate === 0) {
            verifiedCount++;
            db.prepare('UPDATE scrape_jobs SET verified_count = ? WHERE id = ?').run(verifiedCount, jobId);
            saveLog(jobId, 'success', `✅ VERIFIED LEAD #${verifiedCount}: ${contacts.name || post.author} | ${contacts.email}`);
          }

          await new Promise(r => setTimeout(r, 500));
        }
      }

      // ========== CRAIGSLIST ==========
      if ((sourceFilter === 'all' || sourceFilter === 'craigslist') && verifiedCount < targetLeads) {
        saveLog(jobId, 'info', `\n📍 Searching Craigslist (${cities.length} cities)...`);

        // Reuse a single browser for all CL work to avoid connection exhaustion
        let clBrowser = null;
        try {
          saveLog(jobId, 'brightdata', `🌐 Opening shared Craigslist browser...`);
          clBrowser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS });
        } catch (e) {
          saveLog(jobId, 'error', `❌ Could not connect browser: ${e.message}`);
        }

        // Helper: fetch a single CL post using shared browser (with reconnect)
        async function fetchCLPost(url) {
          // Reconnect if dropped
          if (!clBrowser || !clBrowser.isConnected()) {
            try {
              if (clBrowser) await clBrowser.close().catch(() => {});
              clBrowser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS });
              saveLog(jobId, 'brightdata', `🔄 CL browser reconnected`);
            } catch (e) {
              saveLog(jobId, 'error', `❌ CL reconnect failed: ${e.message}`);
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
            saveLog(jobId, 'success', `✅ ${city}: ${results.length} gigs`);
          } catch (e) {
            saveLog(jobId, 'error', `❌ ${city}: ${e.message}`);
          } finally {
            await page.close().catch(() => {});
          }
          return results;
        }

        for (const city of cities) {
          if (verifiedCount >= targetLeads) break;

          try {
            const listings = await scrapeCLCity(city, keyword);
            saveLog(jobId, 'info', `📊 ${city}: ${listings.length} listings`);

            for (const listing of listings.slice(0, 20)) {
              if (verifiedCount >= targetLeads) break;

              // URL dedup
              const urlExists = db.prepare('SELECT id FROM intent_leads WHERE url = ?').get(listing.url);
              if (urlExists) {
                saveLog(jobId, 'info', `⏭️ SKIP (seen): ${listing.url.substring(0, 60)}`);
                continue;
              }

              totalCount++;

              // Fetch full post using shared browser
              saveLog(jobId, 'info', `🔍 Fetching: ${listing.title.substring(0, 50)}...`);
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
                    saveLog(jobId, 'ai', `🧠 Email="${contacts.email || 'N/A'}", Phone="${contacts.phone || 'N/A'}"`);
                    postFetched = true;
                  }
                }
              } catch (fetchErr) {
                saveLog(jobId, 'warning', `⚠️ Post fetch failed: ${fetchErr.message}`);
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
                    saveLog(jobId, 'hunter', `🔍 Hunter domain search: ${domain}`);
                    const domainEmail = await findEmailByDomain(domain);
                    if (domainEmail) {
                      contacts.email = domainEmail;
                      contacts.website = website;
                      saveLog(jobId, 'success', `📧 Hunter found: ${domainEmail}`);
                    }
                  } catch(e) {}
                }
              }

              // Budget filter
              if (budgetFilter > 0 && contacts.budget) {
                const budgetNum = parseInt(contacts.budget.replace(/[^0-9]/g, ''));
                if (budgetNum > 0 && budgetNum < budgetFilter) {
                  saveLog(jobId, 'reject', `❌ REJECTED: Budget $${budgetNum} < $${budgetFilter}`);
                  totalCount--;
                  continue;
                }
              }

              // Verify email
              let emailVerified = false;
              let emailStatus = null;
              if (contacts.email) {
                saveLog(jobId, 'hunter', `📧 HUNTER.IO: Verifying ${contacts.email}...`);
                const verification = await verifyEmail(contacts.email);
                emailVerified = verification.valid;
                emailStatus = verification.status;
                saveLog(jobId, emailVerified ? 'success' : 'warning', `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailStatus || 'unverified'}`);
              }

              // Cross-job email dedup
              let isDuplicate = 0;
              if (contacts.email && emailVerified) {
                const emailExists = db.prepare('SELECT id FROM intent_leads WHERE email = ? AND job_id != ?').get(contacts.email, jobId);
                if (emailExists) {
                  isDuplicate = 1;
                  saveLog(jobId, 'warning', `♻️ DUPLICATE email: ${contacts.email}`);
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
                saveLog(jobId, 'warning', `⚠️ DB insert skipped (dupe URL)`);
                totalCount--;
                continue;
              }

              db.prepare('UPDATE scrape_jobs SET total_count = ? WHERE id = ?').run(totalCount, jobId);

              // Count + emit only verified non-duplicate leads
              if (emailVerified && isDuplicate === 0) {
                verifiedCount++;
                db.prepare('UPDATE scrape_jobs SET verified_count = ? WHERE id = ?').run(verifiedCount, jobId);
                saveLog(jobId, 'success', `✅ VERIFIED LEAD #${verifiedCount}: ${contacts.name || 'Craigslist Poster'} | ${contacts.email}`);
              }

              await new Promise(r => setTimeout(r, 500));
            }

          } catch (error) {
            saveLog(jobId, 'error', `❌ ${city}: ${error.message}`);
          }
          await new Promise(r => setTimeout(r, 500));
        }

        if (clBrowser) await clBrowser.close().catch(() => {});
      }

      // Mark job complete
      db.prepare(
        `UPDATE scrape_jobs SET status = 'complete', verified_count = ?, total_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(verifiedCount, totalCount, jobId);

      saveLog(jobId, 'success', `\n🎯 SEARCH COMPLETE! Verified: ${verifiedCount} / ${targetLeads} | Total processed: ${totalCount}`);

    } catch (fatalErr) {
      console.error('Search background fatal:', fatalErr);
      try {
        db.prepare(`UPDATE scrape_jobs SET status = 'error', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
        saveLog(jobId, 'error', `❌ Fatal background error: ${fatalErr.message}`);
      } catch(e) {}
    }
  });
});

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
  console.log(`🔑 APIs: Bright Data ✅ | Hunter ✅ | Gemini ✅`);
});
