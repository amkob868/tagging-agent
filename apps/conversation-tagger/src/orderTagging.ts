import { logger } from '@support-agent-aws/shared';

export interface OrderNotificationResult {
  isAcmePrintsNotification: boolean;
  suggestedTags: string[];
  buyerEmail: string | null;
}

/**
 * Strip HTML tags and entities to produce clean plain text for matching.
 * Keeps the original casing — callers should lowercase as needed.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAcmePrintsOrderNotification(emailBodyHtml: string): OrderNotificationResult {
  const result: OrderNotificationResult = {
    isAcmePrintsNotification: false,
    suggestedTags: [],
    buyerEmail: null,
  };

  // These checks run on raw HTML since we need exact brand name casing
  if (!emailBodyHtml.includes('AcmePrints') && !emailBodyHtml.includes('Acme Prints')) {
    return result;
  }

  if (!emailBodyHtml.includes('New Order Received') && !emailBodyHtml.includes('Support Team Notification')) {
    return result;
  }

  result.isAcmePrintsNotification = true;

  // Strip HTML before any text matching — this is the key fix.
  // Previously we ran regex on raw HTML, so tags/entities between
  // "SKU:" and the value would silently break mixed order detection.
  const plainText = stripHtml(emailBodyHtml);
  const textLower = plainText.toLowerCase();

  // Extract buyer email from "placed by Name (email@example.com)"
  // Run on plain text so HTML tags inside the pattern don't break it
  const buyerEmailMatch = plainText.match(/placed by[^(]+\(([^)]+@[^)]+)\)/i);
  if (buyerEmailMatch) {
    result.buyerEmail = buyerEmailMatch[1].trim().toLowerCase();
  }

  // Check for Rush — look for "rush processing" as a specific phrase (appears in order totals)
  // or "print processing rush" (appears in timeline when Rush badge is present).
  // Previously we checked for "rush" + "print processing" separately, which false-positived
  // when "rush" appeared anywhere (product name, address, etc.) since all orders have "print processing".
  if (textLower.includes('rush processing') || textLower.includes('print processing rush')) {
    result.suggestedTags.push('rush print order');
  }

  // Check for shipping methods
  if (textLower.includes('fedex overnight') || (textLower.includes('overnight') && textLower.includes('fedex'))) {
    result.suggestedTags.push('overnight shipping');
  } else if (textLower.includes('fedex 2 day') || textLower.includes('fedex 2-day') || textLower.includes('fedex two day')) {
    result.suggestedTags.push('fedex 2 day');
  } else if (textLower.includes('usps priority mail') || textLower.includes('priority mail')) {
    result.suggestedTags.push('priority mail');
  } else if (textLower.includes('fedex ground')) {
    result.suggestedTags.push('fedex');
  }

  // Check for large orders (total over $300)
  const totalMatch = plainText.match(/(?:order\s+)?total[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
  if (totalMatch) {
    const orderTotal = parseFloat(totalMatch[1].replace(/,/g, ''));
    if (orderTotal > 300) {
      result.suggestedTags.push('large order');
      logger.info('Large order detected', { orderTotal });
    }
  }

  // Check for pearl products
  if (textLower.includes('pearl')) {
    result.suggestedTags.push('pearl');
  }

  // Check for foam board products
  const hasFoamBoard = textLower.includes('foam board poster') || textLower.includes('foamboard');

  if (hasFoamBoard) {
    result.suggestedTags.push('foam board poster');

    // Detect mixed orders using SKU patterns — foam board SKUs contain "foamboard",
    // so if any SKU doesn't contain "foamboard", the order has non-foam items
    const skuMatches = [...textLower.matchAll(/sku:\s*(acme-[^\s,]+)/g)];
    const hasNonFoamBoardItem = skuMatches.some(match => !match[1].includes('foamboard'));

    logger.info('Mixed order check', {
      hasFoamBoard: true,
      skuCount: skuMatches.length,
      skus: skuMatches.map(m => m[1]),
      hasNonFoamBoardItem,
    });

    if (hasNonFoamBoardItem) {
      result.suggestedTags.push('mixed order');
      logger.info('Mixed order detected via SKU analysis');
    } else if (skuMatches.length === 0) {
      // SKU regex didn't match anything — the email format may have changed.
      // Fall back to text-based detection: if the text contains a non-foam "poster"
      // or "print" mention, treat it as mixed.
      logger.warn('No SKUs found in foam board order — falling back to text-based mixed order detection', {
        emailTextLength: textLower.length,
      });

      const textWithoutFoam = textLower
        .replace(/foam\s*board\s*poster/g, '')
        .replace(/foamboard/g, '');
      const hasNonFoamPoster = textWithoutFoam.includes('poster');
      const hasNonFoamPrint = /\b(photo|lustre|luster|matte|glossy|canvas|metal|acrylic|paper)\s+print/.test(textWithoutFoam);

      if (hasNonFoamPoster || hasNonFoamPrint) {
        result.suggestedTags.push('mixed order');
        logger.info('Mixed order detected via text fallback', {
          reason: hasNonFoamPoster ? 'non-foam poster text' : 'non-foam print product text',
        });
      }
    }
  }

  return result;
}
