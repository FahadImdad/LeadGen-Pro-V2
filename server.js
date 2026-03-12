/**
 * LeadGen Pro v2 - Intent-Based Lead Generation
 * Uses Apify for all scraping (bypasses blocks)
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

console.log('🔑 API Keys:', {
  hunter: !!HUNTER_API_KEY,
  apollo: !!APOLLO_API_KEY,
  apify: !!APIFY_API_KEY,
  gemini: !!GEMINI_API_KEY
});

let allLeads = [];

// ============================================================
// APIFY GOOGLE SEARCH - Main scraping method
// ============================================================
async function searchViaApify(keyword, source = 'all') {
  if (!APIFY_API_KEY) {
    console.log('⚠️ Apify not configured');
    return [];
  }

  try {
    console.log(`🔍 Searching via Apify for "${keyword}"...`);
    
    // Specific queries for actual job posts
    const queries = [];
    // Reddit r/forhire [Hiring] posts only
    queries.push(`site:reddit.com/r/forhire "[Hiring]" ${keyword}`);
    // Upwork actual job posts (not category pages)
    queries.push(`site:upwork.com/freelance-jobs "${keyword}" -/location -/skill`);
    // Craigslist gigs
    queries.push(`site:craigslist.org/gig "${keyword}"`);

    // Use Apify's Google Search Results Scraper
    const response = await fetch(
      `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${APIFY_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: queries.join('\n'),
          maxPagesPerQuery: 1,
          resultsPerPage: 50,
          countryCode: 'us',
          languageCode: 'en',
          mobileResults: false,
          includeUnfilteredResults: false
        })
      }
    );

    if (!response.ok) {
      console.log('❌ Apify Google error:', response.status);
      return [];
    }

    const results = await response.json();
    const leads = [];

    for (const item of results) {
      if (!item.organicResults) continue;
      
      for (const result of item.organicResults) {
        const url = result.url || '';
        const title = result.title || '';
        const snippet = result.description || '';
        
        // Determine source
        let leadSource = 'Web';
        if (url.includes('reddit.com')) leadSource = 'Reddit';
        else if (url.includes('craigslist.org')) leadSource = 'Craigslist';
        else if (url.includes('upwork.com')) leadSource = 'Upwork';
        
        // Extract email if present
        const emailMatch = snippet.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        
        // Skip [For Hire] posts and category pages
        const titleLower = title.toLowerCase();
        const urlLower = url.toLowerCase();
        
        // Skip non-job posts
        if (titleLower.includes('[for hire]') || titleLower.includes('for hire')) continue;
        if (titleLower.includes('how to') || titleLower.includes('where to')) continue;
        if (titleLower.includes('best place') || titleLower.includes('recommend')) continue;
        
        // Skip Upwork category/location pages
        if (urlLower.includes('upwork.com/freelance-jobs/') && !urlLower.includes('/job/')) {
          // Only keep if it's NOT a category page (has specific job ID or query)
          if (urlLower.match(/\/freelance-jobs\/[a-z-]+\/?$/)) continue;
        }
        
        // Skip Reddit discussion posts (not r/forhire)
        if (url.includes('reddit.com') && !url.includes('/r/forhire/') && !url.includes('/r/hiring/')) continue;
        
        leads.push({
          name: leadSource === 'Reddit' ? title.match(/\[Hiring\]\s*(.*?)(?:\s*[\[\(]|$)/i)?.[1] || 'Reddit Poster' : 'Lead',
          email: emailMatch?.[0] || '',
          phone: '-',
          company: '-',
          title: title.substring(0, 100),
          source: leadSource,
          intent: snippet.substring(0, 200),
          intentScore: leadSource === 'Reddit' && title.toLowerCase().includes('[hiring]') ? 10 : 8,
          url: url,
          verified: false
        });
      }
    }

    console.log(`✅ Apify: Found ${leads.length} leads`);
    return leads;

  } catch (err) {
    console.log('❌ Apify error:', err.message);
    return [];
  }
}

// ============================================================
// APOLLO.IO - B2B Contacts (requires paid plan)
// ============================================================
async function searchApollo(keyword, options = {}) {
  if (!APOLLO_API_KEY) return [];

  try {
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': APOLLO_API_KEY
      },
      body: JSON.stringify({
        q_keywords: keyword,
        per_page: options.limit || 25
      })
    });

    if (!response.ok) return [];

    const data = await response.json();
    return (data.people || []).map(p => ({
      name: p.name || `${p.first_name} ${p.last_name}`,
      email: p.email,
      phone: p.phone_numbers?.[0]?.number || '-',
      company: p.organization?.name || '-',
      title: p.title || '-',
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
// HUNTER.IO - Email Verification
// ============================================================
async function verifyEmail(email) {
  if (!HUNTER_API_KEY || !email || !email.includes('@')) {
    return { valid: false };
  }

  try {
    const response = await fetch(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`
    );

    if (!response.ok) return { valid: false };

    const data = await response.json();
    return {
      valid: data.data?.status === 'valid' || data.data?.status === 'accept_all'
    };

  } catch (err) {
    return { valid: false };
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

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    let results = [];

    send('status', { message: `Searching for "${keyword}"...` });

    // Apollo (if configured and paid)
    if (sources.includes('apollo') && APOLLO_API_KEY) {
      send('status', { message: '🔍 Searching Apollo.io...' });
      const apolloResults = await searchApollo(keyword, { limit: 25 });
      results = results.concat(apolloResults);
    }

    // Apify scraping for Reddit/Upwork/Craigslist
    send('status', { message: '🔍 Searching job boards via Apify...' });
    const apifyResults = await searchViaApify(keyword, sources);
    results = results.concat(apifyResults);

    send('status', { message: `Found ${results.length} leads. Verifying emails...` });

    // Verify emails
    let verified = 0;
    for (let i = 0; i < Math.min(results.length, 10); i++) { // Limit verification to save credits
      const lead = results[i];
      if (lead.email && !lead.verified) {
        const v = await verifyEmail(lead.email);
        lead.verified = v.valid;
        if (v.valid) verified++;
      }
      send('lead', { lead, index: i + 1, total: results.length });
    }

    // Send remaining leads
    for (let i = 10; i < results.length; i++) {
      send('lead', { lead: results[i], index: i + 1, total: results.length });
    }

    allLeads = results;

    send('complete', { total: results.length, verified, leads: results });
    res.end();

  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LeadGen Pro v2 running on port ${PORT}`);
});

module.exports = app;
