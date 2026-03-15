const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
require('dotenv').config();

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

// Craigslist cities
const CRAIGSLIST_CITIES = [
  'sfbay', 'newyork', 'losangeles', 'chicago', 'seattle', 'boston', 'austin',
  'denver', 'miami', 'atlanta', 'dallas', 'phoenix', 'portland', 'sandiego',
  'washingtondc', 'philadelphia', 'houston', 'detroit', 'minneapolis', 'tampa',
  'orlando', 'nashville', 'charlotte', 'raleigh', 'saltlakecity', 'lasvegas',
  'sacramento', 'sanjose', 'sandiego', 'stlouis', 'pittsburgh', 'cleveland',
  'cincinnati', 'columbus', 'indianapolis', 'milwaukee', 'kansascity', 'memphis',
  'baltimore', 'richmond', 'newjersey', 'brooklyn', 'queens', 'longisland',
  'orangecounty', 'inlandempire', 'ventura', 'santabarbara', 'fresno', 'bakersfield'
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

// Scrape Craigslist using Puppeteer (Browser API)
async function scrapeCraigslistCity(city, keyword, sendEvent) {
  const results = [];
  let browser = null;
  
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
    });
    
    const page = await browser.newPage();
    const url = keyword 
      ? `https://${city}.craigslist.org/search/ggg?query=${encodeURIComponent(keyword)}`
      : `https://${city}.craigslist.org/search/ggg`;
    
    sendEvent('log', { level: 'brightdata', message: `🌐 BROWSER: Loading ${city}.craigslist.org...` });
    
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Extract listings
    const listings = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('li.cl-static-search-result, li.cl-search-result, ol.cl-static-search-results > li').forEach(li => {
        const titleEl = li.querySelector('.titlestring, a.titlestring');
        const priceEl = li.querySelector('.priceinfo, .price');
        const link = li.querySelector('a[href]');
        
        if (link && titleEl) {
          items.push({
            url: link.href,
            title: titleEl.textContent.trim(),
            price: priceEl?.textContent?.trim() || ''
          });
        }
      });
      
      // Backup: find title links directly
      if (items.length === 0) {
        document.querySelectorAll('a.titlestring').forEach(a => {
          items.push({ url: a.href, title: a.textContent.trim(), price: '' });
        });
      }
      
      return items;
    });
    
    for (const item of listings) {
      results.push({
        url: item.url,
        title: item.title,
        price: item.price,
        city: city
      });
    }
    
    sendEvent('log', { level: 'success', message: `✅ ${city}: Found ${results.length} gigs` });
    await page.close();
    
  } catch (error) {
    sendEvent('log', { level: 'error', message: `❌ ${city}: ${error.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
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
  const cities = region && region !== 'all' ? [region] : CRAIGSLIST_CITIES.slice(0, 20); // 20 cities for volume
  
  // ========== REDDIT FIRST (faster, more reliable) ==========
  if (sourceFilter === 'all' || sourceFilter === 'reddit') {
    sendEvent('log', { level: 'info', message: `🔍 Starting Reddit search for "${keyword}"...` });
    sendEvent('status', { message: `Searching Reddit...` });
    
    const redditPosts = await scrapeReddit(keyword, sendEvent, timeFilter);
    
    for (const post of redditPosts) {
      if (leads.length >= maxResults) break;
      
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
          sendEvent('lead', { lead });
        }
        
        sendEvent('log', { level: 'info', message: `📊 ${city}: Added ${listings.length} leads (Total: ${leads.length})` });
        
      } catch (error) {
        sendEvent('log', { level: 'error', message: `❌ ${city}: ${error.message}` });
      }
    }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
  console.log(`🔑 APIs: Bright Data ✅ | Hunter ✅ | Gemini ✅`);
});
