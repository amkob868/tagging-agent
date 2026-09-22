/**
 * Shared types for the Support Agent AWS system
 */

// Help Scout types
// Supports both V1 (nested under record) and V2 (flat) payload formats
export interface HelpScoutWebhookPayload {
  // V2 format - data at root level
  id?: number;
  number?: number;
  type?: string;
  mailboxId?: number;
  status?: string;
  subject?: string;
  preview?: string;
  tags?: Array<{ name: string } | string>;
  primaryCustomer?: {
    id: number;
    email: string;
    first?: string;
    last?: string;
  };
  _embedded?: {
    threads?: Array<{
      body?: string;
      createdBy?: {
        type: string;
      };
    }>;
  };
  // V1 format - data nested under record
  record?: {
    id: number;
    number: number;
    type: string;
    mailboxId: number;
    status: string;
    subject: string;
    primaryCustomer: {
      id: number;
      email: string;
      first?: string;
      last?: string;
    };
  };
}

export interface ProcessingContext {
  conversationId: number;
  customerId: number;
  customerEmail: string;
  mailboxId?: number;
  emailSubject?: string;
  emailBody?: string;
  emailBodyHtml?: string;
  buyerEmail?: string; // For AcmePrints orders, the actual buyer's email (different from sender)
  organizations?: Organization[];
  designOrg?: Organization;
  enduserOrg?: Organization;
  integrations?: Integration[];
  propertiesUpdated?: string[];
  isMovedConversation?: boolean; // True when triggered by convo.moved webhook
  tagsAdded?: string[];
  noteCreated?: boolean;
  translationCreated?: boolean;
  errors?: ProcessingError[];
}

// Mailbox IDs
export const MAILBOX_IDS = {
  SUPPORT: 100001,
  PRINTS: 100002,
} as const;

export interface Organization {
  orgId: string;
  type: 'ENDUSER' | 'DESIGN';
  status: string;
  name: string;
  contactEmail: string;
  planId?: string;
  affiliateAccountId?: string;
  affiliateStatus?: string;
}

export interface Integration {
  integrationId: string;
  orgId: string;
  source: 'ETSY' | 'SHOPIFY' | 'WOOCOMMERCE';
  status: string;
  attributes: string; // JSON string
}

export interface ProcessingError {
  step: string;
  message: string;
  recoverable: boolean;
}

// Step Function event types
export interface StepFunctionEvent {
  context: ProcessingContext;
}

export interface StepFunctionResult {
  success: boolean;
  context: ProcessingContext;
  error?: string;
}

// Help Scout Customer types
export interface CustomerProperty {
  name: string;
  value: string;
}

export interface CustomerEmail {
  id: number;
  value: string;
  type: string;
}

export interface Customer {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  emails?: CustomerEmail[];
  properties?: CustomerProperty[];
}

// Help Scout Conversation types
export interface ConversationTag {
  id: number;
  name: string;
  color: string;
}

export interface Conversation {
  id: number;
  number: number;
  type: string;
  status: string;
  subject: string;
  mailboxId: number;
  tags?: ConversationTag[];
}
