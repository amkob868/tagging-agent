import { describe, it, expect, vi } from 'vitest';
import { stripHtml, parseAcmePrintsOrderNotification } from './orderTagging';

// Mock the shared logger
vi.mock('@support-agent-aws/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────

/** Wrap plain text in a minimal AcmePrints order notification email */
function makeOrderEmail(body: string, opts?: { brand?: string; subject?: string }): string {
  const brand = opts?.brand ?? 'AcmePrints';
  const subject = opts?.subject ?? 'New Order Received';
  return `<html><body><h1>${brand} - ${subject}</h1><div>${body}</div></body></html>`;
}

function makeOrderWithSkus(skus: string[], extras?: { shipping?: string; rush?: boolean; pearl?: boolean }): string {
  const items = skus
    .map(sku => {
      const isFoam = sku.includes('foamboard');
      const name = isFoam ? 'Foam Board Poster 8x10' : 'Photo Print 8x10';
      return `<tr><td>${name}</td><td>SKU: ${sku}</td></tr>`;
    })
    .join('\n');

  let extra = '';
  if (extras?.shipping) extra += `<p>Shipping: ${extras.shipping}</p>`;
  if (extras?.rush) extra += `<p>Rush Print Processing</p>`;
  if (extras?.pearl) extra += `<p>Pearl Finish Photo Print</p>`;

  return makeOrderEmail(`
    <p>Order placed by John Doe (john@example.com)</p>
    <table>${items}</table>
    ${extra}
  `);
}

// ─── stripHtml ──────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('replaces &nbsp; with spaces', () => {
    expect(stripHtml('SKU:&nbsp;acme-poster-8x10')).toBe('SKU: acme-poster-8x10');
  });

  it('decodes common HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('<td>SKU:</td>   <td>acme-poster-8x10</td>')).toBe('SKU: acme-poster-8x10');
  });

  it('handles nested tags between SKU label and value', () => {
    const html = '<td>SKU:</td><td><span class="sku">acme-foamboard-8x10</span></td>';
    const text = stripHtml(html);
    expect(text).toContain('SKU:');
    expect(text).toContain('acme-foamboard-8x10');
  });
});

// ─── parseAcmePrintsOrderNotification ──────────────────────────────

describe('parseAcmePrintsOrderNotification', () => {
  describe('notification detection', () => {
    it('returns false for non-AcmePrints emails', () => {
      const result = parseAcmePrintsOrderNotification('<html><body>Hello world</body></html>');
      expect(result.isAcmePrintsNotification).toBe(false);
      expect(result.suggestedTags).toEqual([]);
    });

    it('returns false when missing order subject markers', () => {
      const result = parseAcmePrintsOrderNotification('<html><body>AcmePrints status update</body></html>');
      expect(result.isAcmePrintsNotification).toBe(false);
    });

    it('detects "Acme Prints" with space', () => {
      const html = '<html><body>Acme Prints - New Order Received</body></html>';
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.isAcmePrintsNotification).toBe(true);
    });

    it('detects "Support Team Notification" variant', () => {
      const html = '<html><body>AcmePrints - Support Team Notification</body></html>';
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.isAcmePrintsNotification).toBe(true);
    });
  });

  describe('buyer email extraction', () => {
    it('extracts buyer email', () => {
      const html = makeOrderEmail('Order placed by Jane Smith (jane@test.com)');
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.buyerEmail).toBe('jane@test.com');
    });

    it('returns null when no buyer email found', () => {
      const html = makeOrderEmail('Some order details');
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.buyerEmail).toBeNull();
    });

    it('extracts buyer email even when wrapped in HTML tags', () => {
      const html = makeOrderEmail('Order <b>placed by</b> <span>Jane Smith</span> (<a href="mailto:jane@test.com">jane@test.com</a>)');
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.buyerEmail).toBe('jane@test.com');
    });
  });

  describe('mixed order detection', () => {
    it('detects mixed order with foam + regular SKUs', () => {
      const html = makeOrderWithSkus(['acme-foamboard-8x10', 'acme-poster-8x10']);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
    });

    it('does NOT tag mixed order for foam-only orders', () => {
      const html = makeOrderWithSkus(['acme-foamboard-8x10', 'acme-foamboard-11x14']);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).not.toContain('mixed order');
    });

    it('does NOT tag foam or mixed for regular-only orders', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10', 'acme-poster-11x14']);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).not.toContain('foam board poster');
      expect(result.suggestedTags).not.toContain('mixed order');
    });

    it('detects mixed order when SKUs are separated by HTML tags', () => {
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <table>
          <tr><td>Foam Board Poster</td></tr>
          <tr><td>SKU:</td><td>acme-foamboard-8x10</td></tr>
          <tr><td>Photo Print</td></tr>
          <tr><td>SKU:</td><td>acme-poster-8x10</td></tr>
        </table>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
    });

    it('detects mixed order when SKU has &nbsp; spacing', () => {
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <p>Foam Board Poster - SKU:&nbsp;acme-foamboard-8x10</p>
        <p>Photo Print - SKU:&nbsp;acme-poster-8x10</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
    });

    it('detects mixed order when SKU is inside nested spans', () => {
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <div>Foam Board Poster</div>
        <div>SKU: <span class="sku-value"><b>acme-foamboard-8x10</b></span></div>
        <div>Poster Print</div>
        <div>SKU: <span class="sku-value"><b>acme-poster-8x10</b></span></div>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('mixed order');
    });
  });

  describe('text fallback when SKU regex fails', () => {
    it('falls back to text detection when no SKUs found but has non-foam poster', () => {
      // Email mentions foam board AND regular poster but has NO SKU: lines at all
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <p>Foam Board Poster 8x10 - Qty: 1</p>
        <p>Poster 11x14 - Qty: 2</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
    });

    it('falls back to text detection when no SKUs found but has non-foam print product', () => {
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <p>Foam Board Poster 8x10</p>
        <p>Glossy Print 8x10</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
    });

    it('does NOT false-positive on foam-only order with no SKUs', () => {
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <p>Foam Board Poster 8x10 - Qty: 1</p>
        <p>Foam Board Poster 11x14 - Qty: 2</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).not.toContain('mixed order');
    });

    it('prefers SKU-based detection over text fallback when SKUs exist', () => {
      // Has SKUs but they're all foamboard — should NOT trigger text fallback
      // even though "Poster" appears in the product name
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <p>Foam Board Poster 8x10 - SKU: acme-foamboard-8x10</p>
        <p>Foam Board Poster 11x14 - SKU: acme-foamboard-11x14</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).not.toContain('mixed order');
    });

    it('handles SKUs in unknown format by falling back to text', () => {
      // SKUs present but don't match the acme- pattern
      const html = makeOrderEmail(`
        Order placed by Test User (test@example.com)
        <p>Foam Board Poster 8x10 - SKU: FB-8X10-001</p>
        <p>Poster 11x14 - SKU: PT-11X14-002</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
    });
  });

  describe('shipping detection', () => {
    it('detects overnight shipping', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10'], { shipping: 'FedEx Overnight' });
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('overnight shipping');
    });

    it('detects fedex 2 day', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10'], { shipping: 'FedEx 2 Day' });
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('fedex 2 day');
    });

    it('detects priority mail', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10'], { shipping: 'USPS Priority Mail' });
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('priority mail');
    });

    it('detects fedex ground as fedex', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10'], { shipping: 'FedEx Ground' });
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('fedex');
    });
  });

  describe('rush order detection', () => {
    it('detects rush print order', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10'], { rush: true });
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('rush print order');
    });
  });

  describe('pearl detection', () => {
    it('detects pearl product', () => {
      const html = makeOrderWithSkus(['acme-poster-8x10'], { pearl: true });
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('pearl');
    });
  });

  describe('large order detection', () => {
    it('tags orders over $300 as large order', () => {
      const html = makeOrderEmail(`
        Order placed by John Doe (john@example.com)
        <p>Photo Print 24x36 - Qty: 5</p>
        <p>Order Total: $450.00</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('large order');
    });

    it('does NOT tag orders at or under $300', () => {
      const html = makeOrderEmail(`
        Order placed by John Doe (john@example.com)
        <p>Photo Print 8x10 - Qty: 1</p>
        <p>Order Total: $29.99</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).not.toContain('large order');
    });

    it('tags orders exactly at $300.01 as large order', () => {
      const html = makeOrderEmail(`
        Order placed by John Doe (john@example.com)
        <p>Order Total: $300.01</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('large order');
    });

    it('does NOT tag orders exactly at $300.00', () => {
      const html = makeOrderEmail(`
        Order placed by John Doe (john@example.com)
        <p>Order Total: $300.00</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).not.toContain('large order');
    });

    it('handles totals with comma separators', () => {
      const html = makeOrderEmail(`
        Order placed by John Doe (john@example.com)
        <p>Order Total: $1,250.00</p>
      `);
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('large order');
    });
  });

  describe('combined scenarios', () => {
    it('detects mixed order + rush + overnight in same email', () => {
      const html = makeOrderWithSkus(
        ['acme-foamboard-8x10', 'acme-poster-8x10'],
        { rush: true, shipping: 'FedEx Overnight' }
      );
      const result = parseAcmePrintsOrderNotification(html);
      expect(result.suggestedTags).toContain('foam board poster');
      expect(result.suggestedTags).toContain('mixed order');
      expect(result.suggestedTags).toContain('rush print order');
      expect(result.suggestedTags).toContain('overnight shipping');
    });
  });
});
