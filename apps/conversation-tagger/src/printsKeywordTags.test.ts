import { describe, it, expect, vi } from 'vitest';

// Mock external modules pulled in by index.ts so importing it doesn't hit AWS/HelpScout
vi.mock('@support-agent-aws/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  setRequestId: vi.fn(),
  getClaudeCredentials: vi.fn(),
  getJevCredentials: vi.fn(),
  MAILBOX_IDS: { PRINTS: 999 },
}));

vi.mock('@support-agent-aws/helpscout-client', () => ({
  helpScoutClient: {
    getConversation: vi.fn(),
    updateConversationTags: vi.fn(),
  },
}));

import { getPrintsKeywordTags } from './index';

describe('getPrintsKeywordTags', () => {
  it('tags egg shell when the paper type is mentioned', () => {
    const tags = getPrintsKeywordTags('Question about paper', 'Can I get this printed on eggshell paper?');
    expect(tags).toContain('egg shell');
  });

  it.each([
    'ACME-A7-PLAIN-EGGSHELL-UW',
    'ACME-A2-PLAIN-EGGSHELL-UW',
    'ACME-A1-PLAIN-EGGSHELL-W',
  ])('does not tag egg shell from excepted envelope SKU %s', (sku) => {
    const tags = getPrintsKeywordTags(
      'Your Order has Shipped!',
      `Navy Officer Promotion 70 7x5 Standard ${sku}`
    );
    expect(tags).not.toContain('egg shell');
  });

  it('tags egg shell for eggshell SKUs that are not in the exception list', () => {
    const tags = getPrintsKeywordTags(
      'Your Order has Shipped!',
      'Wedding Invite 50 5x7 Standard ACME-A9-LINED-EGGSHELL-UW'
    );
    expect(tags).toContain('egg shell');
  });

  it('does not tag pearl from an envelope SKU name', () => {
    const tags = getPrintsKeywordTags(
      'Your Order has Shipped!',
      'Wedding Invite 50 5x7 Standard ACME-A7-PLAIN-PEARL-UW'
    );
    expect(tags).not.toContain('pearl');
  });

  it('still tags egg shell when mentioned alongside an excepted envelope SKU', () => {
    const tags = getPrintsKeywordTags(
      'Order question',
      'I ordered eggshell paper with ACME-A7-PLAIN-EGGSHELL-UW envelopes'
    );
    expect(tags).toContain('egg shell');
  });
});
