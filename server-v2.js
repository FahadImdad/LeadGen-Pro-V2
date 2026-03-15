const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API Keys
const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY || '5a584083-5018-4883-873c-0e5aa20b2dc4';
const HUNTER_API_KEY = process.env.HUNTER_API_KEY || '69c57f365f57b2cf963d086bbfc5c8d0002a382b';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyBsBOAYZ8noNRBvnRz4-qfsQED3JmLF0n4';

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

// Scrape URL using Bright Data
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
      timeout: 60000
    });
    return response.data;
  } catch (error) {
    console.error('Bright Data error:', error.message);
    return null;
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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

// Parse Craigslist search results
function parseCraigslistSearch(html, city) {
  const results = [];
  
  // Match listing items
  const listingRegex = /<li[^>]*class="[^"]*cl-search-result[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*class="label"[^>]*>([^<]+)<\/span>[\s\S]*?<\/li>/gi;
  
  let match;
  while ((match = listingRegex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();
    
    if (url && title) {
      results.push({
        url: url.startsWith('http') ? url : `https://${city}.craigslist.org${url}`,
        title: title,
        city: city
      });
    }
  }
  
  // Alternative parsing for different HTML structure
  if (results.length === 0) {
    const altRegex = /href="(\/[^"]*\/gig\/[^"]+)"[^>]*>([^<]+)</gi;
    while ((match = altRegex.exec(html)) !== null) {
      results.push({
        url: `https://${city}.craigslist.org${match[1]}`,
        title: match[2].trim(),
        city: city
      });
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

// Main search endpoint
app.post('/api/search', async (req, res) => {
  const { keyword, region, timeFilter, maxResults = 50 } = req.body;
  
  console.log(`[${new Date().toISOString()}] Search: "${keyword}" in ${region || 'all regions'}`);
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  
  const leads = [];
  const cities = region && region !== 'all' ? [region] : CRAIGSLIST_CITIES.slice(0, 10); // Limit cities for speed
  
  sendEvent('status', { message: `Searching ${cities.length} cities...` });
  
  for (const city of cities) {
    sendEvent('log', { level: 'brightdata', message: `🌐 BRIGHT DATA: Connecting to ${city}.craigslist.org...` });
    
    try {
      // Search Craigslist gigs
      const searchUrl = `https://${city}.craigslist.org/search/ggg?query=${encodeURIComponent(keyword)}`;
      sendEvent('log', { level: 'brightdata', message: `🔗 BRIGHT DATA: Fetching ${searchUrl}` });
      
      const searchHtml = await scrapeWithBrightData(searchUrl);
      
      if (!searchHtml) {
        sendEvent('log', { level: 'error', message: `❌ BRIGHT DATA: Failed to scrape ${city} - blocked or timeout` });
        continue;
      }
      
      sendEvent('log', { level: 'brightdata', message: `✅ BRIGHT DATA: Successfully scraped ${city} (${searchHtml.length} bytes)` });
      
      const listings = parseCraigslistSearch(searchHtml, city);
      sendEvent('log', { level: 'info', message: `📋 Found ${listings.length} gig listings in ${city}` });
      
      if (listings.length === 0) {
        sendEvent('log', { level: 'warning', message: `⚠️ No listings found in ${city} for "${keyword}" - trying next city` });
        continue;
      }
      
      // Process each listing (limit per city)
      for (const listing of listings.slice(0, 5)) {
        if (leads.length >= maxResults) break;
        
        sendEvent('log', { level: 'ai', message: `🤖 AI: Analyzing post "${listing.title.substring(0, 50)}..."` });
        
        // Get full post
        sendEvent('log', { level: 'brightdata', message: `🔗 BRIGHT DATA: Fetching full post content...` });
        const postHtml = await scrapeWithBrightData(listing.url);
        
        if (!postHtml) {
          sendEvent('log', { level: 'reject', message: `❌ REJECTED: Could not fetch post content - skipping` });
          continue;
        }
        
        const postData = parseCraigslistPost(postHtml);
        
        if (!postData.body || postData.body.length < 20) {
          sendEvent('log', { level: 'reject', message: `❌ REJECTED: Post body too short or empty - not a valid lead` });
          continue;
        }
        
        // Extract contacts with AI
        sendEvent('log', { level: 'ai', message: `🧠 AI: Extracting contacts using Gemini AI...` });
        const contacts = await extractContactsWithAI(postData.body, listing.title);
        
        // Log what AI found
        sendEvent('log', { level: 'ai', message: `🧠 AI Result: Name="${contacts.name || 'N/A'}", Email="${contacts.email || 'N/A'}", Phone="${contacts.phone || 'N/A'}"` });
        
        // Check if we have any contact info
        if (!contacts.email && !contacts.phone && !contacts.whatsapp) {
          sendEvent('log', { level: 'reject', message: `⚠️ LOW PRIORITY: No direct contact found - will include as website-only lead` });
        }
        
        // Verify email if found
        let emailVerified = false;
        if (contacts.email) {
          sendEvent('log', { level: 'hunter', message: `📧 HUNTER.IO: Verifying email ${contacts.email}...` });
          const verification = await verifyEmail(contacts.email);
          emailVerified = verification.valid;
          
          if (emailVerified) {
            sendEvent('log', { level: 'success', message: `✅ HUNTER.IO: Email VERIFIED - ${contacts.email} is valid!` });
          } else {
            sendEvent('log', { level: 'warning', message: `⚠️ HUNTER.IO: Email UNVERIFIED - ${contacts.email} may be invalid (${verification.status})` });
          }
        }
        
        // Build lead object
        const lead = {
          id: leads.length + 1,
          name: contacts.name || 'Unknown',
          title: listing.title,
          description: contacts.description || listing.title,
          email: contacts.email || null,
          emailVerified: emailVerified,
          phone: contacts.phone || null,
          whatsapp: contacts.whatsapp || null,
          budget: contacts.budget || null,
          city: city,
          source: 'craigslist',
          url: listing.url,
          postedDate: postData.postedDate,
          scrapedAt: new Date().toISOString()
        };
        
        lead.contactPriority = getContactPriority(lead);
        lead.contactType = getContactType(lead.contactPriority);
        
        leads.push(lead);
        sendEvent('log', { level: 'success', message: `✅ LEAD ACCEPTED: ${lead.name} | ${lead.contactType.toUpperCase()} | ${lead.city}` });
        sendEvent('lead', { lead });
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      }
      
      if (leads.length >= maxResults) {
        sendEvent('log', { level: 'info', message: `🎯 Reached max results (${maxResults}) - stopping search` });
        break;
      }
      
    } catch (error) {
      sendEvent('log', { level: 'error', message: `❌ ERROR in ${city}: ${error.message}` });
      console.error(`Error searching ${city}:`, error.message);
    }
  }
  
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
