import axios from 'axios';
import { logger } from '@support-agent-aws/shared';

// ============================================
// JEV (TypeSafe AI) CLASSIFIER
// ============================================
//
// Jev answers a batch of independent yes/no ("noul") questions about a piece of
// text and returns a 0-1 probability for each. We ask one question per tag and
// apply the tag when the probability meets JEV_TAG_THRESHOLD (default 70%).

const JEV_API_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';
export const JEV_TAG_THRESHOLD = clampThreshold(parseFloat(process.env.JEV_TAG_THRESHOLD || '0.7'));
const JEV_TIMEOUT_MS = 20_000;
const JEV_MAX_BODY_CHARS = 15_000;
const RETRYABLE_STATUSES = new Set([429, 529, 500, 502, 503, 504]);

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0, value));
}

export interface TagQuestion {
  /** Yes/no question Jev evaluates against the email */
  instructions: string;
  /** Optional explicit descriptions of what counts as true / false */
  criteria?: { true: string; false: string };
}

/** Map of tag name -> question. Tag names are the exact Help Scout tag strings. */
export type TagQuestionMap = Record<string, TagQuestion>;

interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

interface JevResponse {
  model: string;
  answers: Record<string, JevNoulAnswer | { type: string; [key: string]: unknown }>;
  usage?: { input_tokens: number; output_tokens: number };
}

// ---------- Tag definitions ----------

export const SUPPORT_TAG_QUESTIONS: TagQuestionMap = {
  'acme customer': {
    instructions: 'Is the sender a Acme customer / end user (a buyer of a customizable product), NOT a designer or seller?',
  },
  'missing order': {
    instructions: 'Is the sender reporting that an order is missing, not showing up, or cannot be found?',
  },
  'how do i respond to my customer': {
    instructions: 'Is a designer/seller explicitly asking Acme support for advice on what to say to, or how to help, their own buyer/customer?',
    criteria: {
      true: 'The designer directly requests guidance on how to reply to or handle their customer.',
      false: 'The designer merely reports a customer issue, forwards a complaint, or mentions a customer in passing without asking how to respond.',
    },
  },
  'email change': {
    instructions: 'Is the sender asking to update or change the email address on their account?',
  },
  'general': {
    instructions: 'Is this a general question about the Acme platform that does not fit a more specific category (orders, downloads, listings, categories, account changes, cancellation, data removal)?',
  },
  '2.0 how do I': {
    instructions: 'Is the sender asking how to use or do something in the 2.0 version of Acme?',
  },
  'need more info': {
    instructions: 'Does the email genuinely lack the details (order number, listing, account, description of the problem) needed to help the sender?',
  },
  'data removal': {
    instructions: 'Is the sender requesting that their data be removed or deleted?',
  },
  'cancel': {
    instructions: 'Is the sender asking to cancel their account or subscription?',
  },
  'downloads': {
    instructions: 'Is the email about downloads (needing more downloads, being out of downloads, a file that will not download, download errors)?',
  },
  'listing issue': {
    instructions: 'Is the email about a problem or issue with a listing?',
  },
  'categories': {
    instructions: 'Does a seller/designer have a question, concern, or possible bug about Acme categories (Tags, Collections, or Folders)?',
  },
  'not a friend of acme': {
    instructions: 'Is the email hostile, angry, threatening to leave for a competitor (like Canva), demanding staff be fired, or an unconstructive/rude complaint?',
  },
};

export const PRINTS_TAG_QUESTIONS: TagQuestionMap = {
  'foam board poster': {
    instructions: 'Is the email about a foam board poster print product?',
  },
  'pearl': {
    instructions: 'Does the email mention pearlescent (pearl) finish or paper print products?',
  },
  'shipping question': {
    instructions: 'Is the customer asking about shipping status, delivery time, or when their order will arrive?',
  },
  'question about print order': {
    instructions: 'Is the customer asking a general question about a print order (status, details, changes) other than delivery/arrival questions?',
  },
  'priority mail': {
    instructions: 'Is the customer asking about or requesting priority mail shipping, or does the email mention 2-3 business day shipping?',
  },
  'overnight shipping': {
    instructions: 'Is the customer asking about or requesting overnight / next-day shipping?',
  },
  'rush order': {
    instructions: 'Does the customer need their order rushed, expedited, or completed urgently?',
  },
};

// ---------- Pure helpers (unit tested) ----------

/** Jev question keys must be simple identifiers; derive one from the tag name. */
export function questionKeyForTag(tagName: string): string {
  return tagName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function buildJevQuestions(tagQuestions: TagQuestionMap): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [tagName, question] of Object.entries(tagQuestions)) {
    questions[questionKeyForTag(tagName)] = {
      type: 'noul',
      instructions: question.instructions,
      ...(question.criteria ? { criteria: question.criteria } : {}),
    };
  }
  return questions;
}

export interface JevTagResult {
  tags: string[];
  /** Probability per tag name, for logging */
  scores: Record<string, number>;
}

/**
 * Turn Jev's answers into a tag list: a tag is applied when its noul
 * probability is >= threshold. Missing or malformed answers are skipped.
 */
export function tagsFromJevAnswers(
  answers: JevResponse['answers'] | undefined,
  tagQuestions: TagQuestionMap,
  threshold: number = JEV_TAG_THRESHOLD
): JevTagResult {
  const tags: string[] = [];
  const scores: Record<string, number> = {};
  if (!answers) return { tags, scores };

  for (const tagName of Object.keys(tagQuestions)) {
    const answer = answers[questionKeyForTag(tagName)];
    const probability = answer && typeof (answer as JevNoulAnswer).noul === 'number'
      ? (answer as JevNoulAnswer).noul
      : undefined;
    if (probability === undefined) continue;
    scores[tagName] = probability;
    if (probability >= threshold) {
      tags.push(tagName);
    }
  }
  return { tags, scores };
}

// ---------- API call ----------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call Jev with the email as state and one noul question per tag.
 * Throws on failure so the caller can fall back to another classifier.
 */
export async function classifyWithJev(
  apiKey: string,
  state: Record<string, unknown>,
  tagQuestions: TagQuestionMap
): Promise<JevTagResult> {
  const payload = {
    model: JEV_MODEL,
    state,
    questions: buildJevQuestions(tagQuestions),
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      logger.info('Calling Jev API for classification', { attempt, questionCount: Object.keys(payload.questions).length });
      const response = await axios.post<JevResponse>(JEV_API_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: JEV_TIMEOUT_MS,
      });

      const result = tagsFromJevAnswers(response.data?.answers, tagQuestions);
      logger.info('Jev classification complete', {
        model: response.data?.model,
        threshold: JEV_TAG_THRESHOLD,
        tags: result.tags,
        scores: result.scores,
        usage: response.data?.usage,
      });
      return result;
    } catch (error: any) {
      lastError = error;
      const status: number | undefined = error?.response?.status;
      const data = error?.response?.data;
      logger.warn('Jev API call failed', {
        attempt,
        status,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: data ? JSON.stringify(data).substring(0, 500) : undefined,
      });
      if (attempt < 2 && (status === undefined || RETRYABLE_STATUSES.has(status))) {
        await sleep(1000);
        continue;
      }
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Jev classification failed');
}

function truncateBody(body: string): string {
  return body.length > JEV_MAX_BODY_CHARS ? `${body.slice(0, JEV_MAX_BODY_CHARS)}…` : body;
}

export async function classifySupportEmailWithJev(
  apiKey: string,
  emailSubject: string,
  emailBody: string,
  isDesigner: boolean,
  isEnduser: boolean
): Promise<string[]> {
  const senderType = isDesigner ? 'Designer (seller)' : (isEnduser ? 'End User (customer/buyer)' : 'Unknown');

  // Sender type is known from Acme org lookup, so decide "acme customer" deterministically
  // and only ask Jev when the sender is unknown.
  const questions: TagQuestionMap = { ...SUPPORT_TAG_QUESTIONS };
  if (isDesigner || isEnduser) {
    delete questions['acme customer'];
  }

  const state = {
    context: 'Support email to Acme, a platform where designers sell customizable digital products to end users/customers.',
    sender_type: senderType,
    subject: emailSubject,
    body: truncateBody(emailBody),
  };

  const { tags } = await classifyWithJev(apiKey, state, questions);

  if (isEnduser && !isDesigner && !tags.includes('acme customer')) {
    tags.unshift('acme customer');
  }
  return tags;
}

export async function classifyPrintsEmailWithJev(
  apiKey: string,
  emailSubject: string,
  emailBody: string,
  senderEmail: string,
  isThirdPartyPrinter: boolean
): Promise<string[]> {
  const state = {
    context: 'Support email to Acme Prints, a print fulfillment service for customizable products.',
    sender_type: isThirdPartyPrinter ? '3rd Party Printer (automated notification)' : 'Customer or Unknown',
    sender_email: senderEmail,
    subject: emailSubject,
    body: truncateBody(emailBody),
  };

  const { tags } = await classifyWithJev(apiKey, state, PRINTS_TAG_QUESTIONS);
  return tags;
}
