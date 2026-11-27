// הכללים של סוכן המבצעים: קורא PromoFull ומחזיר מבצעים על מוצרי הקטלוג. נכנס כמו שהוא לצומת Code ב-n8n.
// xml: הקובץ. catalog: Map item_code -> { barcode, kg }. shelf: Map item_code -> מחיר מדף. now: Date
function parsePromos(xml, catalog, shelf, now) {
  const SKIP_WORDS = /קופון|אשראי|תו זהב|למשלמים|אפליקציה|פיצוי|מתנה/;
  const skipped = { coupon: 0, suspicious: 0, unknown: 0, weighted: 0 };
  const suspicious = [];
  const rows = [];
  const tag = (s, t) => {
    const r = s.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>', 'i'));
    return r ? r[1].trim() : '';
  };
  const num = (v) => (v === '' || v == null ? null : Number(v));
  // תאריך ושעה: PromotionStartDateTime, או PromotionStartDate עם PromotionStartHour (וולט)
  // השעות בקובץ הן שעון ישראל: +02:00 בחורף, +03:00 בקיץ
  const israel = (local) => {
    const guess = new Date(local + 'Z');
    const shown = new Date(guess.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }) + ' UTC');
    return new Date(guess.getTime() - (shown - guess));
  };
  const when = (s, side) => {
    const full = tag(s, 'Promotion' + side + 'DateTime');
    if (full) return israel(full.slice(0, 19));
    const d = tag(s, 'Promotion' + side + 'Date');
    if (!d) return null;
    const h = tag(s, 'Promotion' + side + 'Hour') || (side === 'End' ? '23:59:59' : '00:00:00');
    return israel(d + 'T' + h.slice(0, 8));
  };
  const seen = new Set();
  const re = /<Promotion>([\s\S]*?)<\/Promotion>/g;
  let m;
  while ((m = re.exec(xml))) {
    const s = m[1];
    const items = [...s.matchAll(/<PromotionItem>([\s\S]*?)<\/PromotionItem>/g)].map((x) => x[1]);
    const hits = items.filter((it) => catalog.has(tag(it, 'ItemCode')));
    if (!hits.length) continue;
    const start = when(s, 'Start');
    const end = when(s, 'End');
    if (end && end <= now) continue; // פג תוקף: לא נספר
    const id = tag(s, 'PromotionID') || tag(s, 'PromotionId');
    const description = tag(s, 'PromotionDescription').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const club = tag(s, 'ClubID') || tag(s, 'ClubId');
    const clubOnly = !/^0(\s|-|$)/.test(club);
    const minAmount = num(tag(s, 'MinPurchaseAmount'));
    const coupon = tag(s, 'AdditionalIsCoupon') === '1' || minAmount > 0 || SKIP_WORDS.test(description);
    for (const it of hits) {
      const code = tag(it, 'ItemCode');
      if (seen.has(id + ':' + code)) continue;
      seen.add(id + ':' + code);
      if (coupon) { skipped.coupon++; continue; }
      if (catalog.get(code).kg || (tag(it, 'bIsWeighted') || tag(it, 'blsWeighted')) === '1') { skipped.weighted++; continue; }
      const rt = tag(it, 'RewardType');
      const min = Math.max(1, num(tag(it, 'MinQty')) || 1);
      const max = num(tag(it, 'MaxQty')) || null;
      const price = num(tag(it, 'DiscountedPrice'));
      const rate = num(tag(it, 'DiscountRate'));
      let row = null;
      // 3: מחיר ליחידה. 1 ו-10: המחיר ל-min יחידות. 2: אחוז הנחה על כל יחידה
      if (rt === '3' && price > 0) row = { kind: 'unit', bundle_price: price, unitPrice: price };
      else if ((rt === '1' || rt === '10') && price > 0 && min > 1) row = { kind: 'bundle', bundle_price: price, unitPrice: price / min };
      else if ((rt === '1' || rt === '10') && price > 0) row = { kind: 'unit', bundle_price: price, unitPrice: price };
      else if (rt === '2' && rate > 0 && rate < 100) row = { kind: 'percent', discount_rate: rate, unitPrice: null };
      if (!row) { skipped.unknown++; continue; }
      // מחיר חשוד: גבוה ממחיר המדף, או נמוך מ-20% ממנו
      const sh = shelf.get(code);
      const unit = row.kind === 'percent' ? sh * (1 - rate / 100) : row.unitPrice;
      if (sh > 0 && (unit >= sh || unit < sh * 0.2)) {
        skipped.suspicious++;
        suspicious.push({ item_code: code, barcode: catalog.get(code).barcode, shelf: sh, promo: Math.round(unit * 100) / 100, description });
        continue;
      }
      if (!(sh > 0)) { skipped.unknown++; continue; } // אין מחיר מדף להשוואה: לא מציגים
      rows.push({
        promo_id: id, item_code: code, description, kind: row.kind, min_qty: row.kind === 'percent' && rt === '2' ? 1 : min,
        bundle_price: row.bundle_price ?? null, discount_rate: row.discount_rate ?? null, max_qty: max,
        club_only: clubOnly, starts_at: start ? start.toISOString() : null, ends_at: end ? end.toISOString() : null,
      });
    }
  }
  return { rows, skipped, suspicious };
}
if (typeof module !== 'undefined') module.exports = { parsePromos };
