const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ============================================================
// DATA PERSISTENCE HELPERS
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SEEN_LEADS_FILE  = path.join(DATA_DIR, 'seen-leads.json');
const SEEN_ASINS_FILE  = path.join(DATA_DIR, 'seen-asins.json');
const RUN_HISTORY_FILE = path.join(DATA_DIR, 'run-history.json');

function readJsonFile(filePath, defaultVal) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { console.error(`Failed to read ${filePath}:`, e.message); }
  return defaultVal;
}

function writeJsonFile(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error(`Failed to write ${filePath}:`, e.message); }
}

// Framework 1 — seen URLs
function loadSeenLeads()     { return new Set(readJsonFile(SEEN_LEADS_FILE, [])); }
function saveSeenLeads(set)  { writeJsonFile(SEEN_LEADS_FILE, [...set]); }

// Framework 2 — seen ASINs
function loadSeenAsins()     { return new Set(readJsonFile(SEEN_ASINS_FILE, [])); }
function saveSeenAsins(set)  { writeJsonFile(SEEN_ASINS_FILE, [...set]); }

// Run history
function loadRunHistory()    { return readJsonFile(RUN_HISTORY_FILE, []); }
function appendRunHistory(entry) {
  const history = loadRunHistory();
  history.push(entry);
  writeJsonFile(RUN_HISTORY_FILE, history);
}

function getLastAmazonRun() {
  const history = loadRunHistory();
  if (!history.length) return null;
  // Return the most recent entry
  return history[history.length - 1];
}

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

// Scrape Craigslist using Bright Data Browser API (with JS rendering)
async function scrapeWithBrowser(url, waitSelector = null) {
  let browser = null;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
    });
    
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    // Wait for content to load
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

// Scrape Craigslist using Browser API with response interception
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
    
    // Intercept API responses - capture the one with full item data (has titles)
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('sapi.craigslist.org') && url.includes('postings/search/full')) {
        try {
          const json = await response.json();
          const items = json?.data?.items || [];
          // Only use items that have full data (array length >= 10 means has title)
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
    
    // Wait for API responses to be processed (they come slightly after page load)
    for (let i = 0; i < 10 && apiItems.length === 0; i++) {
      await new Promise(r => setTimeout(r, 500));
    }
    
    sendEvent('log', { level: 'info', message: `📊 Total API items captured: ${apiItems.length}` });
    
    // Parse captured API items
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
  
  // Extract post body
  const bodyMatch = html.match(/<section[^>]*id="postingbody"[^>]*>([\s\S]*?)<\/section>/i);
  if (bodyMatch) {
    body = bodyMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  // Extract posted date
  let postedDate = null;
  const dateMatch = html.match(/datetime="([^"]+)"/);
  if (dateMatch) {
    postedDate = dateMatch[1];
  }
  
  return { body, postedDate };
}

// Determine contact priority
function getContactPriority(lead) {
  if (lead.email && lead.emailVerified) return 1; // Email
  if (lead.phone) return 2; // Phone
  if (lead.whatsapp) return 3; // WhatsApp
  if (lead.email && !lead.emailVerified) return 4; // Unverified email
  return 6; // Website only
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

// Scrape Reddit for freelance GIGS (not job postings)
async function scrapeReddit(keyword, sendEvent, timeFilterDays = 7) {
  const results = [];
  const axios = require('axios');
  
  // Calculate cutoff time
  const cutoffTime = Date.now() - (timeFilterDays * 24 * 60 * 60 * 1000);
  sendEvent('log', { level: 'info', message: `⏰ Filtering posts from last ${timeFilterDays} day(s)` });
  
  // Subreddits with freelance gigs - expanded list
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
        
        // Different detection logic per subreddit type
        if (sub.type === 'task') {
          // For r/slavelabour style: [TASK] = client needs work, [OFFER] = freelancer offering
          const isTask = titleLower.includes('[task]') || flairLower.includes('task');
          const isOffer = titleLower.includes('[offer]') || flairLower.includes('offer');
          isValidGig = isTask && !isOffer;
        } else {
          // For r/forhire style: need more complex filtering
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
          
          // Exclude JOB postings
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
          
          // Exclude [For Hire]
          const isForHire = 
            titleLower.includes('[for hire]') ||
            titleLower.includes('for hire') ||
            flairLower.includes('for hire');
          
          isValidGig = isGig && !isJob && !isForHire;
        }
        
        // Must match keyword (skip check if keyword is empty - show all)
        const matchesKeyword = 
          !keyword || 
          keyword.trim() === '' ||
          sub.searchType === 'search' || 
          titleLower.includes(keyword.toLowerCase()) ||
          bodyLower.includes(keyword.toLowerCase());
        
        // Check time filter
        const postTime = p.created_utc * 1000;
        const isRecent = postTime >= cutoffTime;
        
        if (isValidGig && matchesKeyword && isRecent) {
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

// Main search endpoint
app.post('/api/search', async (req, res) => {
  const { keyword, region, timeFilter = 7, sourceFilter = 'all', budgetFilter = 0, maxResults = 50 } = req.body;
  
  console.log(`[${new Date().toISOString()}] Search: "${keyword}" in ${region || 'all regions'} | Time: ${timeFilter}d | Source: ${sourceFilter} | Budget: $${budgetFilter}+`);
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  
  const leads = [];
  let cities;
  if (!region || region === 'all') {
    cities = CRAIGSLIST_CITIES.slice(0, 50);
  } else if (region.includes(',')) {
    cities = region.split(',').map(r => r.trim()).filter(r => r);
  } else {
    cities = [region];
  }

  // Deduplication — load seen lead URLs
  const seenLeads = loadSeenLeads();
  const newLeadUrls = [];
  sendEvent('log', { level: 'info', message: `🔁 Dedup: ${seenLeads.size} previously seen URLs loaded` });
  
  // ========== REDDIT FIRST (faster, more reliable) ==========
  if (sourceFilter === 'all' || sourceFilter === 'reddit') {
    sendEvent('log', { level: 'info', message: `🔍 Starting Reddit search for "${keyword}"...` });
    sendEvent('status', { message: `Searching Reddit...` });
    
    const redditPosts = await scrapeReddit(keyword, sendEvent, timeFilter);
    
    for (const post of redditPosts) {
      if (leads.length >= maxResults) break;

      // Dedup check
      if (seenLeads.has(post.url)) {
        sendEvent('log', { level: 'info', message: `⏭️ SKIP (seen): ${post.url.substring(0, 60)}` });
        continue;
      }
      
      sendEvent('log', { level: 'ai', message: `🤖 AI: Analyzing "${post.title.substring(0, 50)}..."` });
      
      const contacts = await extractContactsWithAI(post.body, post.title);
      sendEvent('log', { level: 'ai', message: `🧠 AI Result: Email="${contacts.email || 'N/A'}", Budget="${contacts.budget || 'N/A'}"` });
      
      // Check budget filter
      if (budgetFilter > 0 && contacts.budget) {
        const budgetNum = parseInt(contacts.budget.replace(/[^0-9]/g, ''));
        if (budgetNum > 0 && budgetNum < budgetFilter) {
          sendEvent('log', { level: 'reject', message: `❌ REJECTED: Budget $${budgetNum} < $${budgetFilter}` });
          continue;
        }
      }
      
      let emailVerified = false;
      if (contacts.email) {
        sendEvent('log', { level: 'hunter', message: `📧 HUNTER.IO: Verifying ${contacts.email}...` });
        const verification = await verifyEmail(contacts.email);
        emailVerified = verification.valid;
        sendEvent('log', { level: emailVerified ? 'success' : 'warning', message: `${emailVerified ? '✅' : '⚠️'} HUNTER.IO: ${emailVerified ? 'VERIFIED' : 'UNVERIFIED'}` });
      }
      
      const lead = {
        id: leads.length + 1,
        name: contacts.name || post.author || 'Unknown',
        title: post.title,
        description: contacts.description || post.title.substring(0, 100),
        email: contacts.email || null,
        emailVerified: emailVerified,
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
      
      leads.push(lead);
      seenLeads.add(post.url);
      newLeadUrls.push(post.url);
      sendEvent('log', { level: 'success', message: `✅ LEAD #${lead.id}: ${lead.name} | ${lead.contactType.toUpperCase()}` });
      sendEvent('lead', { lead });
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  // ========== CRAIGSLIST (main source for volume) ==========
  if ((sourceFilter === 'all' || sourceFilter === 'craigslist') && leads.length < maxResults) {
    sendEvent('log', { level: 'info', message: `\n📍 Searching Craigslist (${cities.length} cities)...` });
    sendEvent('status', { message: `Searching Craigslist...` });
    
    for (const city of cities) {
      if (leads.length >= maxResults) break;
      
      try {
        // Scrape city using Browser API
        const listings = await scrapeCraigslistCity(city, keyword, sendEvent);
        
        // Process each listing (limit per city for speed)
        for (const listing of listings.slice(0, 20)) {
          if (leads.length >= maxResults) break;

          // Dedup check
          if (seenLeads.has(listing.url)) {
            sendEvent('log', { level: 'info', message: `⏭️ SKIP (seen): ${listing.url.substring(0, 60)}` });
            continue;
          }
          
          // Create lead directly from listing (skip fetching full post for speed)
          const lead = {
            id: leads.length + 1,
            name: 'Craigslist Poster',
            title: listing.title,
            description: listing.title,
            email: null,
            emailVerified: false,
            phone: null,
            whatsapp: null,
            budget: listing.price || null,
            city: city,
            source: 'craigslist',
            url: listing.url,
            postedDate: new Date().toISOString(),
            scrapedAt: new Date().toISOString()
          };
          
          lead.contactPriority = 6;
          lead.contactType = 'website';
          
          leads.push(lead);
          seenLeads.add(listing.url);
          newLeadUrls.push(listing.url);
          sendEvent('lead', { lead });
        }
        
        sendEvent('log', { level: 'info', message: `📊 ${city}: Added ${listings.length} leads (Total: ${leads.length})` });
        
      } catch (error) {
        sendEvent('log', { level: 'error', message: `❌ ${city}: ${error.message}` });
      }
    }
  }

  // Persist new seen URLs
  if (newLeadUrls.length > 0) {
    saveSeenLeads(seenLeads);
    sendEvent('log', { level: 'info', message: `💾 Saved ${newLeadUrls.length} new URLs to dedup store` });
  }
  
  sendEvent('log', { level: 'success', message: `\n🎯 SEARCH COMPLETE! Total leads: ${leads.length}` });
  sendEvent('complete', { 
    total: leads.length,
    byType: {
      email: leads.filter(l => l.contactType === 'email').length,
      phone: leads.filter(l => l.contactType === 'phone').length,
      whatsapp: leads.filter(l => l.contactType === 'whatsapp').length,
      email_unverified: leads.filter(l => l.contactType === 'email_unverified').length,
      website: leads.filter(l => l.contactType === 'website').length
    }
  });
  
  res.end();
});

// Get available cities
app.get('/api/cities', (req, res) => {
  res.json({ cities: CRAIGSLIST_CITIES });
});

// Health check
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

// Debug endpoint to test Craigslist scraping
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
// FRAMEWORK 2: AMAZON AUTHOR LEAD GEN
// ============================================================

// Build Amazon search URL based on dateFilter
function buildAmazonUrl(dateFilter, page = 1) {
  let base = 'https://www.amazon.com/s?i=stripbooks&s=date-desc-rank&rh=n%3A283155';
  if (dateFilter === 'today') {
    base += '%2Cp_n_publication_date%3A1250226011';
  } else if (dateFilter === '7days') {
    base += '%2Cp_n_publication_date%3A1250227011';
  } else if (dateFilter === '30days') {
    base += '%2Cp_n_publication_date%3A1250225011';
  }
  // 90days has no special filter — use base URL (recent releases)
  if (page > 1) {
    base += `&page=${page}`;
  }
  return base;
}

// Scrape Amazon new releases and return book objects
async function scrapeAmazonBooks(maxBooks, dateFilter, sendEvent) {
  const books = [];
  let browser = null;
  let page_num = 1;

  sendEvent('log', { level: 'brightdata', message: `🌐 BROWSER: Connecting to Amazon...` });

  try {
    browser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS });

    while (books.length < maxBooks) {
      const url = buildAmazonUrl(dateFilter, page_num);
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
          if (books.length >= maxBooks) break;
          books.push({
            ...book,
            amazonUrl: `https://www.amazon.com/dp/${book.asin}`
          });
        }

        sendEvent('log', { level: 'success', message: `✅ Page ${page_num}: ${pageBooks.length} books (total: ${books.length})` });
        page_num++;

        if (books.length >= maxBooks) break;

        // Small delay between pages
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

  return books.slice(0, maxBooks);
}

// Find author contact info via Google search
async function findAuthorContact(authorName, bookTitle, sendEvent) {
  const query = `"${authorName}" "${bookTitle}" author`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;

  const BLOCKED_DOMAINS = ['google.com', 'amazon.com', 'goodreads.com', 'example.com', 'sentry.io',
    'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'linkedin.com',
    'pinterest.com', 'tumblr.com', 'reddit.com', 'wikipedia.org', 'gstatic.com',
    'googleapis.com', 'aexp.com', 'bookbub.com', 'barnesandnoble.com', 'audible.com',
    'thriftbooks.com', 'booksrun.com', 'jstor.org', 'gutenberg.org', 'sermoncentral.com',
    'bookbeat.com', 'penguinrandomhouse.com', 'tiktok.com', 'gramercybooksbexley.com',
    'awesomebooks.com', 'bookmans.com', 'hymnary.org', 'jacket2.org', 'jimruttshow.com',
    'helpingcouplesheal.com', 'ieee.es', 'alabama.gov', 'bookmanager.com'];

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  function isBlockedEmail(email) {
    // Block file extensions masquerading as emails
    if (email.match(/\.(png|jpg|jpeg|gif|svg|webp|js|css|min\.js|ts)(@|$)/i)) return true;
    // Block obvious fake/placeholder emails
    if (/^(user|admin|info|noreply|no-reply|test|example|support|help|contact|sales|hello)@/i.test(email)) return true;
    // Block emails with version numbers (npm package names)
    if (/\d+\.\d+\.\d+/.test(email)) return true;
    // Block very long local parts (likely code artifacts)
    if (email.split('@')[0].length > 40) return true;
    // Block blocked domains
    if (BLOCKED_DOMAINS.some(d => email.toLowerCase().includes(d))) return true;
    // Block emails that don't look like real personal/business emails
    const domain = email.split('@')[1] || '';
    if (!domain.includes('.')) return true;
    return false;
  }

  const BLOCKED_WEBSITE_PATTERNS = [
    'google.', 'gstatic.com', 'googleapis.com', 'amazon.', 'goodreads.com',
    'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'linkedin.com',
    'pinterest.com', 'reddit.com', 'wikipedia.org', 'bookbub.com', 'audible.com',
    'barnesandnoble.com', 'thriftbooks.com', 'booksrun.com', 'jstor.org',
    'gutenberg.org', 'penguinrandomhouse.com', 'tiktok.com', 'apple.com',
    'microsoft.com', 'cloudflare.com', 'wp.com', 'blogger.com'
  ];

  function extractWebsiteFromHtml(html) {
    const urlRegex = /href="(https?:\/\/[^"]+)"/g;
    let match;
    const candidates = [];
    while ((match = urlRegex.exec(html)) !== null) {
      const url = match[1];
      try {
        const host = new URL(url).hostname.toLowerCase();
        const isBlocked = BLOCKED_WEBSITE_PATTERNS.some(d => host.includes(d));
        // Prefer personal/author websites — short domain, no subpaths that look like aggregators
        if (!isBlocked && !url.includes('/search?') && !url.includes('?q=')) {
          candidates.push(url.split('?')[0]);
        }
      } catch (e) { /* skip malformed */ }
    }
    return candidates.length > 0 ? candidates[0] : null;
  }

  try {
    sendEvent('log', { level: 'brightdata', message: `🔍 Google: Searching for "${authorName}"...` });
    const html = await scrapeWithBrightData(searchUrl);
    if (!html) return { email: null, website: null };

    // Extract emails
    const rawEmails = html.match(emailRegex) || [];
    const emails = rawEmails.filter(e => !isBlockedEmail(e));
    const email = emails.length > 0 ? emails[0] : null;

    // Extract website
    let website = extractWebsiteFromHtml(html);

    // If no email, try visiting the website
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

// Amazon Author Lead Gen SSE endpoint
app.post('/api/amazon', async (req, res) => {
  const { maxBooks = 25, dateFilter = '7days' } = req.body;

  console.log(`[${new Date().toISOString()}] Amazon search: maxBooks=${maxBooks}, dateFilter=${dateFilter}`);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const leads = [];

  sendEvent('log', { level: 'info', message: `🚀 Starting Amazon Author Lead Gen (${maxBooks} books, filter: ${dateFilter})...` });
  sendEvent('status', { message: 'Scraping Amazon new releases...' });

  // Step 1: Scrape Amazon books
  const books = await scrapeAmazonBooks(parseInt(maxBooks), dateFilter, sendEvent);
  sendEvent('log', { level: 'success', message: `📚 Found ${books.length} books on Amazon` });

  if (books.length === 0) {
    sendEvent('log', { level: 'warning', message: `⚠️ No books found. Check Amazon URL/filters.` });
    sendEvent('complete', { total: 0, withEmail: 0, withWebsite: 0 });
    res.end();
    return;
  }

  // Step 2: For each book, find author contact
  sendEvent('status', { message: 'Finding author contacts...' });

  for (const book of books) {
    const title = book.title || 'Unknown Title';
    const author = book.author || 'Unknown Author';

    sendEvent('log', { level: 'info', message: `📚 Processing: ${title} by ${author}` });

    const { email, website } = await findAuthorContact(author, title, sendEvent);

    if (email) {
      sendEvent('log', { level: 'success', message: `✅ Email found: ${email}` });
    } else {
      sendEvent('log', { level: 'warning', message: `⚠️ No email for ${author}` });
    }

    const lead = {
      id: leads.length + 1,
      author,
      bookTitle: title,
      publishDate: book.publishDate || '',
      email: email || null,
      website: website || null,
      amazonUrl: book.amazonUrl,
      scrapedAt: new Date().toISOString()
    };

    leads.push(lead);
    sendEvent('amazon_lead', { lead });

    // Rate limiting delay
    await new Promise(r => setTimeout(r, 1000));
  }

  const withEmail = leads.filter(l => l.email).length;
  const withWebsite = leads.filter(l => l.website).length;

  sendEvent('log', { level: 'success', message: `\n🎯 AMAZON COMPLETE! ${leads.length} authors processed` });
  sendEvent('log', { level: 'success', message: `📧 With Email: ${withEmail} | 🌐 With Website: ${withWebsite}` });
  sendEvent('complete', { total: leads.length, withEmail, withWebsite });

  res.end();
});

// ============================================================
// END FRAMEWORK 2
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
  console.log(`🔑 APIs: Bright Data ✅ | Hunter ✅ | Gemini ✅`);
  console.log(`🔧 Browser WS: ${BROWSER_WS ? 'configured' : 'NOT SET'}`);
});
