const SEARCH_PROVIDERS_TOOL = {
  name: 'search_providers',
  description: 'Search for local service providers on the BridgePro marketplace by keyword or category.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string to find matching providers or services',
      },
      category: {
        type: 'string',
        description: 'Optional category to filter results (e.g. "Plumbing", "Catering")',
      },
    },
    required: ['query'],
  },
};

const SEARCH_PRODUCTS_TOOL = {
  name: 'search_products',
  description: 'Search for products sold by businesses on the BridgePro marketplace.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match product name, description, or category',
      },
      max_price: {
        type: 'number',
        description: 'Optional maximum price filter — returns products at or below this price',
      },
    },
    required: ['query'],
  },
};

const CUSTOMER_TOOLS = [
  SEARCH_PROVIDERS_TOOL,
  SEARCH_PRODUCTS_TOOL,
  {
    name: 'send_enquiry',
    description: 'Send an enquiry message to a specific service provider listing, or reply to an existing conversation.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'The UUID of the provider listing to enquire about (from search_providers results). Required if conversation_id is not provided.',
        },
        message: {
          type: 'string',
          description: 'The enquiry message to send to the provider',
        },
        conversation_id: {
          type: 'string',
          description: 'If you already have a conversation ID from get_my_enquiries, provide it here to reply to an existing conversation instead of starting a new one',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_my_enquiries',
    description: 'Retrieve all enquiries sent by the current customer.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_conversation_thread',
    description: 'Get the full message history of a specific conversation. Use this when you need context about what was previously discussed in a conversation before responding.',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'integer',
          description: 'The integer ID of the conversation to retrieve messages for',
        },
      },
      required: ['conversation_id'],
    },
  },
];

const ANALYZE_IMAGE_TOOL = {
  name: 'analyze_image',
  description: 'Analyze an uploaded image using AI vision to suggest product name, description, price and category. Use when provider uploads a photo and wants to create a product listing from it.',
  input_schema: {
    type: 'object',
    properties: {
      image_url: { type: 'string', description: 'URL of the uploaded image' },
      type: { type: 'string', enum: ['product', 'listing'], description: 'Type of analysis' }
    },
    required: ['image_url', 'type']
  }
};

const PROVIDER_TOOLS = [
  ANALYZE_IMAGE_TOOL,
  {
    name: 'get_incoming_enquiries',
    description: 'Retrieve recent conversations/enquiries sent to the provider\'s listings, including the integer conversation_id needed for respond_to_enquiry.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_my_listings',
    description: 'Retrieve all listings belonging to the current provider.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'respond_to_enquiry',
    description: 'Send a response to a customer enquiry. enquiry_id is the INTEGER conversation ID returned by get_incoming_enquiries (e.g. 11, 12). It is NOT the listing UUID. Always call get_incoming_enquiries first to get the correct integer ID before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        enquiry_id: {
          type: 'string',
          description: 'enquiry_id is the INTEGER conversation ID returned by get_incoming_enquiries (e.g. 11, 12). It is NOT the listing UUID. Always call get_incoming_enquiries first to get the correct integer ID before calling this tool.',
        },
        message: {
          type: 'string',
          description: 'The response message to send to the customer',
        },
      },
      required: ['enquiry_id', 'message'],
    },
  },
  {
    name: 'draft_invoice',
    description: 'Draft an invoice for a completed or agreed job from an enquiry.',
    input_schema: {
      type: 'object',
      properties: {
        enquiry_id: {
          type: 'string',
          description: 'The conversation_id number from get_incoming_enquiries or get_my_enquiries results (e.g. "11" or "12") — NOT a listing UUID',
        },
        amount: {
          type: 'number',
          description: 'The invoice amount in XCD',
        },
        description: {
          type: 'string',
          description: 'Description of the services rendered for this invoice',
        },
      },
      required: ['enquiry_id', 'amount', 'description'],
    },
  },
  {
    name: 'update_listing_status',
    description: 'Activate or deactivate a provider listing.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'The UUID of the listing to update (from get_my_listings results)',
        },
        is_active: {
          type: 'boolean',
          description: 'Set to true to activate the listing, false to deactivate it',
        },
      },
      required: ['listing_id', 'is_active'],
    },
  },
  {
    name: 'get_my_products',
    description: 'Retrieve products belonging to the current provider, optionally filtered by listing.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'Optional UUID of a specific listing to filter products by',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_product',
    description: 'Add a new product to one of the provider\'s listings.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'UUID of the listing this product belongs to (from get_my_listings)',
        },
        name: {
          type: 'string',
          description: 'Product name',
        },
        price: {
          type: 'number',
          description: 'Product price',
        },
        description: {
          type: 'string',
          description: 'Product description',
        },
        category: {
          type: 'string',
          description: 'Product category',
        },
        unit: {
          type: 'string',
          description: 'Unit of sale (e.g. "each", "per kg", "per litre")',
        },
        in_stock: {
          type: 'boolean',
          description: 'Whether the product is currently in stock (defaults to true)',
        },
        currency: {
          type: 'string',
          description: 'Currency code (defaults to XCD)',
        },
      },
      required: ['listing_id', 'name'],
    },
  },
  {
    name: 'update_product',
    description: 'Update an existing product — price, deal/sale price, stock status, or details. For deal_expires you can pass natural strings like "end of month" or "end of year".',
    input_schema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'UUID of the product to update (from get_my_products)',
        },
        name: {
          type: 'string',
          description: 'New product name',
        },
        description: {
          type: 'string',
          description: 'New product description',
        },
        price: {
          type: 'number',
          description: 'New regular price',
        },
        deal_price: {
          type: 'number',
          description: 'Sale/deal price (shown alongside regular price)',
        },
        deal_expires: {
          type: 'string',
          description: 'When the deal expires — accepts ISO date strings or natural language like "end of month", "end of year"',
        },
        in_stock: {
          type: 'boolean',
          description: 'Set to false to mark as out of stock',
        },
      },
      required: ['product_id'],
    },
  },
];

const ADMIN_TOOLS = [
  {
    name: 'get_platform_stats',
    description: 'Retrieve overall platform statistics including user counts, listing counts, and activity metrics.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_pending_listings',
    description: 'Retrieve all listings pending admin review or approval.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

function getToolsForRole(role) {
  switch (role) {
    case 'customer': return [...CUSTOMER_TOOLS, ...PROVIDER_TOOLS];
    case 'provider': return [...CUSTOMER_TOOLS, ...PROVIDER_TOOLS];
    case 'admin':    return [...CUSTOMER_TOOLS, ...PROVIDER_TOOLS, ...ADMIN_TOOLS];
    default:         return [SEARCH_PROVIDERS_TOOL, SEARCH_PRODUCTS_TOOL];
  }
}

function toGroqFormat(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function getGroqToolsForRole(role) {
  return toGroqFormat(getToolsForRole(role));
}

module.exports = { getToolsForRole, getGroqToolsForRole };
