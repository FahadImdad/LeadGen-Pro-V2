/**
 * LeadGen Pro v2 - Intent-Based Lead Generation
 * Sources: Apollo.io + Upwork + Reddit + Craigslist
 * Features: Email verification via Hunter.io
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Keys
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APIFY_API_KEY = process.env.APIFY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

console.log('🔑 API Keys loaded:', {
  hunter: HUNTER_API_KEY ? '✅' : '❌',
  apollo: APOLLO_API_KEY ? '✅' : '❌',
  apify: APIFY_API_KEY ? '✅' : '❌',
  gemini: GEMINI_API_KEY ? '✅' : '❌'
});

// Store leads
let allLeads = [];

// ============================================================
// APOLLO.IO - B2B Contact Database
// ============================================================
async function searchApollo(keyword, options = {}) {
  if (!APOLLO_API_KEY) {
    console.log('⚠️ Apollo API not configured - skipping');
    return [];
  }

  try {
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': APOLLO_API_KEY
      },
      body: JSON.stringify({
        q_keywords: keyword,
        page: options.page || 1,
        per_page: options.limit || 25,
        person_titles: options.titles || [],
        person_locations: options.locations || []
      })
    });

    if (!response.ok) {
      console.log('❌ Apollo error:', response.status);
      return [];
    }

    const data = await response.json();
    const people = data.people || [];

    return people.map(p => ({
      name: p.name || `${p.first_name} ${p.last_name}`,
      email: p.email,
      phone: p.phone_numbers?.[0]?.number || '-',
      company: p.organization?.name || '-',
      title: p.title || '-',
      linkedin: p.linkedin_url || '',
      source: 'Apollo',
      intent: `${p.title} at ${p.organization?.name || 'Unknown'}`,
      intentScore: 7,
      verified: !!p.email
    }));

  } catch (err) {
    console.log('❌ Apollo error:', err.message);
    return [];
  }
}

// ============================================================
// UPWORK - Job Posts (via Apify or Direct)
// ============================================================
async function searchUpwork(keyword, options = {}) {
  try {
    // Use Apify's Upwork scraper
    if (APIFY_API_KEY) {
      console.log('🔍 Searching Upwork via Apify...');
      
      const response = await fetch('https://api.apify.com/v2/acts/epctex~upwork-scraper/run-sync-get-dataset-items?token=' + APIFY_API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchTerms: [keyword],
          maxItems: options.limit || 50
        })
      });

      if (!response.ok) {
        console.log('❌ Apify Upwork error:', response.status);
        return await searchUpworkRSS(keyword);
      }

      const jobs = await response.json();
      return jobs.map(job => ({
        name: job.client?.name || job.clientName || 'Upwork Client',
        email: '', // Will enrich with Hunter
        phone: '-',
        company: job.client?.company || '-',
        title: job.title || 'Job Post',
        source: 'Upwork',
        intent: job.description?.substring(0, 200) || job.title,
        intentScore: 9,
        budget: job.budget || job.hourlyRange || '-',
        url: job.url || job.link,
        verified: false
      }));
    }

    return await searchUpworkRSS(keyword);

  } catch (err) {
    console.log('❌ Upwork error:', err.message);
    return await searchUpworkRSS(keyword);
  }
}

// Upwork search via Google (RSS is dead)
async function searchUpworkRSS(keyword) {
  console.log('⚠️ Upwork RSS deprecated, using Google search fallback');
  
  try {
    // Search Google for Upwork jobs
    const query = `site:upwork.com/freelance-jobs ${keyword}`;
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;
    
    const response = await fetch(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) return [];
    
    const html = await response.text();
    const jobs = [];
    
    // Extract Upwork job links from Google results
    const linkMatches = html.match(/https:\/\/www\.upwork\.com\/freelance-jobs\/[^"&]+/g) || [];
    
    for (const link of [...new Set(linkMatches)].slice(0, 20)) {
      jobs.push({
        name: 'Upwork Client',
        email: '',
        phone: '-',
        company: '-',
        title: decodeURIComponent(link.split('/').pop().replace(/-/g, ' ')).substring(0, 80),
        source: 'Upwork',
        intent: `Job posting for ${keyword}`,
        intentScore: 9,
        url: link,
        verified: false
      });
    }
    
    console.log(`✅ Upwork (Google): Found ${jobs.length} jobs`);
    return jobs;

  } catch (err) {
    console.log('❌ Upwork search error:', err.message);
    return [];
  }
}

// ============================================================
// REDDIT - r/forhire and other subreddits
// ============================================================
async function searchReddit(keyword, options = {}) {
  try {
    const results = [];
    
    // Search multiple subreddits for [Hiring] posts
    const subreddits = ['forhire', 'hiring', 'freelance_forhire'];
    const queries = [`[Hiring]`, `Hiring ${keyword}`];

    for (const sub of subreddits) {
      for (const query of queries) {
        try {
          const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=25&t=month`;
          
          const response = await fetch(url, {
            headers: { 'User-Agent': 'LeadGen/1.0' }
          });

          if (!response.ok) continue;

          const data = await response.json();
          const posts = data.data?.children || [];

          for (const post of posts) {
            const p = post.data;
            const title = p.title || '';
            const flair = p.link_flair_text || '';
            
            // Only accept [Hiring] posts - reject [For Hire]
            const titleLower = title.toLowerCase();
            const flairLower = flair.toLowerCase();
            const isHiring = (titleLower.includes('[hiring]') || flairLower.includes('hiring')) 
              && !titleLower.includes('[for hire]') 
              && !titleLower.includes('for hire')
              && !flairLower.includes('for hire');
            
            if (isHiring) {
              // Extract email from post
              const emailMatch = p.selftext?.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              
              // Avoid duplicates
              const postUrl = `https://reddit.com${p.permalink}`;
              if (results.find(r => r.url === postUrl)) continue;
              
              results.push({
                name: p.author || 'Reddit User',
                email: emailMatch?.[0] || '',
                phone: '-',
                company: '-',
                title: title.substring(0, 100),
                source: 'Reddit',
                intent: p.selftext?.substring(0, 200) || title,
                intentScore: 10,
                url: postUrl,
                verified: false
              });
            }
          }
        } catch (e) {
          console.log(`Reddit ${sub} error:`, e.message);
        }
      }
    }

    console.log(`✅ Reddit: Found ${results.length} [Hiring] posts`);
    return results;

  } catch (err) {
    console.log('❌ Reddit error:', err.message);
    return [];
  }
}

// ============================================================
// CRAIGSLIST - Gigs Section
// ============================================================
async function searchCraigslist(keyword, options = {}) {
  try {
    // Craigslist RSS for gigs
    const cities = ['newyork', 'losangeles', 'chicago', 'houston', 'phoenix'];
    const results = [];

    for (const city of cities.slice(0, 3)) {
      const url = `https://${city}.craigslist.org/search/ggg?format=rss&query=${encodeURIComponent(keyword)}`;
      
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (!response.ok) continue;

      const text = await response.text();
      const items = text.match(/<item[\s\S]*?<\/item>/gi) || [];

      for (const item of items.slice(0, 10)) {
        const title = item.match(/<title>(.*?)<\/title>/)?.[1] || '';
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
        const desc = item.match(/<description>(.*?)<\/description>/)?.[1] || '';
        
        // Try to find email in description
        const emailMatch = desc.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

        if (title) {
          results.push({
            name: 'Craigslist Poster',
            email: emailMatch?.[0] || '',
            phone: '-',
            company: '-',
            title: title,
            source: 'Craigslist',
            intent: desc.replace(/<[^>]+>/g, '').substring(0, 200),
            intentScore: 8,
            url: link,
            verified: false
          });
        }
      }
    }

    console.log(`✅ Craigslist: Found ${results.length} gigs`);
    return results;

  } catch (err) {
    console.log('❌ Craigslist error:', err.message);
    return [];
  }
}

// ============================================================
// HUNTER.IO - Email Verification & Enrichment
// ============================================================
async function verifyEmail(email) {
  if (!HUNTER_API_KEY || !email || !email.includes('@')) {
    return { valid: false, reason: 'Invalid email' };
  }

  try {
    const response = await fetch(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`
    );

    if (!response.ok) return { valid: false, reason: 'API error' };

    const data = await response.json();
    return {
      valid: data.data?.status === 'valid' || data.data?.status === 'accept_all',
      status: data.data?.status,
      score: data.data?.score
    };

  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

async function findEmail(domain, name = '') {
  if (!HUNTER_API_KEY || !domain) {
    return null;
  }

  try {
    let url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}`;
    if (name) {
      url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&full_name=${encodeURIComponent(name)}&api_key=${HUNTER_API_KEY}`;
    }

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    
    if (name) {
      return data.data?.email || null;
    }
    
    // Return first email from domain search
    return data.data?.emails?.[0]?.value || null;

  } catch (err) {
    return null;
  }
}

// ============================================================
// MAIN API: /api/search
// ============================================================
app.get('/api/search', async (req, res) => {
  const { keyword, sources = 'all', limit = 50 } = req.query;

  if (!keyword) {
    return res.status(400).json({ error: 'Keyword required' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    let results = [];
    const sourceList = sources === 'all' ? ['apollo', 'upwork', 'reddit', 'craigslist'] : sources.split(',');

    send('status', { message: `Searching for "${keyword}"...` });

    // Search all sources in parallel
    const searches = [];

    if (sourceList.includes('apollo') && APOLLO_API_KEY) {
      send('status', { message: '🔍 Searching Apollo.io...' });
      searches.push(searchApollo(keyword, { limit: Math.min(limit, 25) }));
    }

    if (sourceList.includes('upwork')) {
      send('status', { message: '🔍 Searching Upwork jobs...' });
      searches.push(searchUpwork(keyword, { limit }));
    }

    if (sourceList.includes('reddit')) {
      send('status', { message: '🔍 Searching Reddit [Hiring]...' });
      searches.push(searchReddit(keyword, { limit }));
    }

    if (sourceList.includes('craigslist')) {
      send('status', { message: '🔍 Searching Craigslist gigs...' });
      searches.push(searchCraigslist(keyword, { limit }));
    }

    const searchResults = await Promise.all(searches);
    results = searchResults.flat();

    send('status', { message: `Found ${results.length} leads. Verifying emails...` });

    // Verify/enrich emails
    let verified = 0;
    for (let i = 0; i < results.length; i++) {
      const lead = results[i];

      // If no email, try to find one
      if (!lead.email && lead.company && lead.company !== '-') {
        send('status', { message: `🔍 Finding email for ${lead.company}...` });
        const foundEmail = await findEmail(lead.company, lead.name);
        if (foundEmail) {
          lead.email = foundEmail;
          lead.verified = true;
          verified++;
        }
      }

      // Verify existing email
      if (lead.email && !lead.verified) {
        const verification = await verifyEmail(lead.email);
        lead.verified = verification.valid;
        if (verification.valid) verified++;
      }

      // Send lead to frontend
      send('lead', { lead, index: i + 1, total: results.length });
    }

    // Filter to only verified emails if requested
    allLeads = results;

    send('complete', {
      total: results.length,
      verified,
      leads: results
    });

    res.end();

  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});

// Export to Excel
app.get('/api/export', (req, res) => {
  const { verified } = req.query;
  let leads = allLeads;

  if (verified === 'true') {
    leads = leads.filter(l => l.verified);
  }

  const ws = XLSX.utils.json_to_sheet(leads.map(l => ({
    Name: l.name,
    Email: l.email,
    Phone: l.phone,
    Company: l.company,
    Title: l.title,
    Source: l.source,
    Intent: l.intent,
    'Intent Score': l.intentScore,
    Verified: l.verified ? 'Yes' : 'No',
    URL: l.url
  })));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=leads.xlsx');
  res.send(buffer);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apis: {
      hunter: !!HUNTER_API_KEY,
      apollo: !!APOLLO_API_KEY,
      apify: !!APIFY_API_KEY,
      gemini: !!GEMINI_API_KEY
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
});
