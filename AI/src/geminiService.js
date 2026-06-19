const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;

async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      const text = await res.text();
      let errData;
      try { errData = JSON.parse(text); } catch { errData = { error: text }; }
      console.warn(`[Gemini Service Attempt ${i + 1} Failed]: status=${res.status}, error=${JSON.stringify(errData)}`);
      if (res.status === 503 || res.status === 429 || res.status === 502 || res.status === 504) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        continue;
      }
      const error = new Error(errData.error?.message || errData.error || `API error ${res.status}`);
      error.status = res.status;
      throw error;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
}

async function analyzeProductImage(base64Image, mimeType = 'image/jpeg') {
  const response = await fetchWithRetry(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'You are a product listing assistant for BridgePro Caribbean marketplace. Analyze this product image and return ONLY a JSON object with these fields: { name: string, description: string (2-3 sentences), suggested_price: number, currency: "XCD", category: string, in_stock: true }. Category must be one of: Food & Catering, Clothing & Fashion, Health & Beauty, Sports & Fitness, Electronics, Home & Garden, Arts & Crafts, Martial Arts Equipment, Entertainment, Other. Be specific and professional. Return ONLY the JSON, no markdown, no explanation.' },
          { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
    })
  });
  const data = await response.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text.replace(/\`\`\`json|\`\`\`/g, '').trim());
}

async function analyzeListingImage(base64Image, mimeType = 'image/jpeg') {
  const response = await fetchWithRetry(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'You are a business listing assistant for BridgePro Caribbean marketplace. Analyze this business/storefront image and return ONLY a JSON object: { business_type: string, suggested_description: string (3-4 sentences professional), suggested_category: string, keywords: string[] (5 keywords) }. Return ONLY the JSON.' },
          { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
    })
  });
  const data = await response.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text.replace(/\`\`\`json|\`\`\`/g, '').trim());
}

async function moderateImage(base64Image, mimeType = 'image/jpeg') {
  const response = await fetchWithRetry(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'You are a content moderator for a Caribbean marketplace. Analyze this image and return ONLY a JSON object: { approved: boolean, reason: string, flags: string[] }. Reject if: explicit content, violence, fake/misleading products, not a real product or business photo.' },
          { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
    })
  });
  const data = await response.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text.replace(/\`\`\`json|\`\`\`/g, '').trim());
}

async function extractText(base64Image, mimeType = "image/jpeg") {
  const response = await fetchWithRetry(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: "Extract ALL text and information from this image. Identify the document type. Return JSON: { document_type, extracted_text, structured_data, suggested_action, suggested_endpoint }" },
          { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1000 }
    })
  });
  const data = await response.json();
  const rawText = data.candidates[0].content.parts[0].text;

  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch(e) {
    return {
      document_type: 'document',
      extracted_text: rawText,
      structured_data: {},
      suggested_action: 'Review the extracted text',
      suggested_endpoint: null
    };
  }
}

module.exports = { analyzeProductImage, analyzeListingImage, moderateImage, extractText };
