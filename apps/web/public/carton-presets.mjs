/**
 * Pure carton preset definitions and distribution helpers for footwear/apparel purchase invoices.
 * Zero DOM or Node dependencies so the exact same logic runs in both browser UI and Node tests.
 */

export const CARTON_TYPES = [
  { id: 'baby', label: 'بيبي', rangeLabel: '22-26', sizes: ['22', '23', '24', '25', '26'] },
  { id: 'pharmacy', label: 'صيدلية', rangeLabel: '18-22', sizes: ['18', '19', '20', '21', '22'] },
  { id: 'kids', label: 'أطفال', rangeLabel: '27-31', sizes: ['27', '28', '29', '30', '31'] },
  { id: 'boys', label: 'أولادي', rangeLabel: '32-36', sizes: ['32', '33', '34', '35', '36'] },
  { id: 'women', label: 'حريمي', rangeLabel: '37-41', sizes: ['37', '38', '39', '40', '41'] },
  { id: 'men', label: 'رجالي', rangeLabel: '42-46', sizes: ['42', '43', '44', '45', '46'] },
];

export const CARTON_SIZES = [5, 10, 15];

export const QUICK_COLORS = [
  'أسود',
  'أبيض',
  'بيج',
  'جملي',
  'بني',
  'كحلي',
  'رمادي',
  'هافان',
  'أحمر',
  'نبيتي',
  'أخضر',
  'زيتي',
  'أزرق',
  'كشمير',
];

const ASCII_COLOR_CODES = new Map([
  ['أسود', 'BLK'],
  ['اسود', 'BLK'],
  ['أبيض', 'WHT'],
  ['ابيض', 'WHT'],
  ['أحمر', 'RED'],
  ['احمر', 'RED'],
  ['أزرق', 'BLU'],
  ['ازرق', 'BLU'],
  ['كحلي', 'NVY'],
  ['بني', 'BRN'],
  ['بيج', 'BGE'],
  ['رمادي', 'GRY'],
  ['رصاصي', 'GRY'],
  ['أخضر', 'GRN'],
  ['اخضر', 'GRN'],
  ['زيتي', 'OLV'],
  ['هافان', 'HAV'],
  ['جملي', 'CML'],
  ['كشمير', 'PNK'],
  ['بينك', 'PNK'],
  ['زهري', 'PNK'],
  ['نبيتي', 'BRG'],
  ['موف', 'PRP'],
  ['أصفر', 'YLW'],
  ['اصفر', 'YLW'],
  ['برتقالي', 'ORG'],
  ['فضي', 'SLV'],
  ['ذهبي', 'GLD'],
]);

function encodeColorSkuToken(rawValue, fallbackIdx) {
  const clean = String(rawValue ?? '').trim();
  const known = ASCII_COLOR_CODES.get(clean.toLowerCase());
  if (known) return known;
  const ascii = clean.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
  if (ascii) return ascii;
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) {
    hash = ((hash * 31) + clean.charCodeAt(i)) >>> 0;
  }
  return `C${fallbackIdx}${hash.toString(36).toUpperCase().slice(0, 3)}`;
}

export function normalizeCartonColors(rawColors) {
  const seen = new Set();
  const colors = [];
  for (const entry of Array.isArray(rawColors) ? rawColors : []) {
    const clean = String(entry ?? '').trim().slice(0, 64);
    if (!clean) continue;
    const norm = clean.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    colors.push(clean);
    if (colors.length >= 50) break;
  }
  return colors;
}

export function buildCartonDistribution({ typeId, cartonSize, colors = [], overrides = null }) {
  const type = CARTON_TYPES.find((item) => item.id === typeId);
  if (!type) {
    throw new Error(`نوع الكرتونة غير معروف (${String(typeId)})`);
  }
  const numericSize = Number.parseInt(String(cartonSize), 10);
  if (!CARTON_SIZES.includes(numericSize)) {
    throw new Error(`حجم الكرتونة يجب أن يكون 5 أو 10 أو 15 قطعة`);
  }

  const normalizedColors = normalizeCartonColors(colors);
  const perSize = Math.floor(numericSize / type.sizes.length);
  const entries = [];
  const quantitiesMap = new Map();
  let evenSplit = true;

  if (normalizedColors.length === 0) {
    const options = [{ key: 'option_1', name: 'المقاس', values: [...type.sizes] }];
    for (const size of type.sizes) {
      const comboKey = `المقاس=${size}`;
      const overrideVal = overrides instanceof Map
        ? overrides.get(comboKey)
        : (overrides && Object.prototype.hasOwnProperty.call(overrides, comboKey) ? overrides[comboKey] : undefined);
      const qty = overrideVal !== undefined
        ? Math.max(0, Math.floor(Number.parseInt(String(overrideVal), 10) || 0))
        : perSize;
      entries.push({
        comboKey,
        color: null,
        size,
        attributes: { option_1: size },
        quantity: qty,
      });
      if (qty > 0) quantitiesMap.set(comboKey, qty);
    }
    const totalPieces = entries.reduce((sum, item) => sum + item.quantity, 0);
    return { type, cartonSize: numericSize, colors: [], options, entries, quantitiesMap, totalPieces, evenSplit };
  }

  const colorCount = normalizedColors.length;
  const basePerCell = Math.floor(perSize / colorCount);
  const remPerSize = perSize % colorCount;
  evenSplit = remPerSize === 0;
  const options = [
    { key: 'option_1', name: 'اللون', values: [...normalizedColors] },
    { key: 'option_2', name: 'المقاس', values: [...type.sizes] },
  ];

  for (let cIdx = 0; cIdx < colorCount; cIdx += 1) {
    const color = normalizedColors[cIdx];
    for (let sIdx = 0; sIdx < type.sizes.length; sIdx += 1) {
      const size = type.sizes[sIdx];
      let generatedQty = basePerCell;
      if (remPerSize > 0) {
        for (let r = 0; r < remPerSize; r += 1) {
          if (((sIdx * remPerSize) + r) % colorCount === cIdx) {
            generatedQty += 1;
            break;
          }
        }
      }
      const comboKey = `اللون=${color}:::المقاس=${size}`;
      const overrideVal = overrides instanceof Map
        ? overrides.get(comboKey)
        : (overrides && Object.prototype.hasOwnProperty.call(overrides, comboKey) ? overrides[comboKey] : undefined);
      const qty = overrideVal !== undefined
        ? Math.max(0, Math.floor(Number.parseInt(String(overrideVal), 10) || 0))
        : generatedQty;
      entries.push({
        comboKey,
        color,
        size,
        attributes: { option_1: color, option_2: size },
        quantity: qty,
      });
      if (qty > 0) quantitiesMap.set(comboKey, qty);
    }
  }

  const totalPieces = entries.reduce((sum, item) => sum + item.quantity, 0);
  return {
    type,
    cartonSize: numericSize,
    colors: normalizedColors,
    options,
    entries,
    quantitiesMap,
    totalPieces,
    evenSplit,
  };
}

export function buildMultiCartonDistribution({ cartons, colors = [], overrides = null }) {
  if (!Array.isArray(cartons) || !cartons.length) {
    throw new Error('أضف كرتونة واحدة على الأقل');
  }
  const normalizedColors = normalizeCartonColors(colors);
  const allSizesSet = new Set();
  const sumByComboKey = new Map();
  let allEvenSplit = true;
  let totalCartons = 0;
  const breakdown = [];

  for (const item of cartons) {
    const cartonCount = Math.max(1, Math.floor(Number.parseInt(String(item?.count ?? 1), 10) || 1));
    const dist = buildCartonDistribution({
      typeId: item?.typeId,
      cartonSize: item?.cartonSize,
      colors: normalizedColors,
    });
    for (const sz of dist.type.sizes) {
      allSizesSet.add(sz);
    }
    for (const entry of dist.entries) {
      sumByComboKey.set(entry.comboKey, (sumByComboKey.get(entry.comboKey) ?? 0) + (entry.quantity * cartonCount));
    }
    if (!dist.evenSplit) allEvenSplit = false;
    totalCartons += cartonCount;
    breakdown.push({
      type: dist.type,
      cartonSize: dist.cartonSize,
      count: cartonCount,
      pieces: dist.totalPieces * cartonCount,
    });
  }

  const sizes = [...allSizesSet].sort((a, b) => Number(a) - Number(b));
  const entries = [];
  const quantitiesMap = new Map();

  if (normalizedColors.length === 0) {
    const options = [{ key: 'option_1', name: 'المقاس', values: [...sizes] }];
    for (const size of sizes) {
      const comboKey = `المقاس=${size}`;
      const generatedQty = sumByComboKey.get(comboKey) ?? 0;
      const overrideVal = overrides instanceof Map
        ? overrides.get(comboKey)
        : (overrides && Object.prototype.hasOwnProperty.call(overrides, comboKey) ? overrides[comboKey] : undefined);
      const qty = overrideVal !== undefined
        ? Math.max(0, Math.floor(Number.parseInt(String(overrideVal), 10) || 0))
        : generatedQty;
      entries.push({
        comboKey,
        color: null,
        size,
        attributes: { option_1: size },
        quantity: qty,
      });
      if (qty > 0) quantitiesMap.set(comboKey, qty);
    }
    const totalPieces = entries.reduce((sum, item) => sum + item.quantity, 0);
    return {
      cartons: breakdown,
      totalCartons,
      sizes,
      colors: [],
      options,
      entries,
      quantitiesMap,
      totalPieces,
      evenSplit: allEvenSplit,
    };
  }

  const options = [
    { key: 'option_1', name: 'اللون', values: [...normalizedColors] },
    { key: 'option_2', name: 'المقاس', values: [...sizes] },
  ];
  for (const color of normalizedColors) {
    for (const size of sizes) {
      const comboKey = `اللون=${color}:::المقاس=${size}`;
      const generatedQty = sumByComboKey.get(comboKey) ?? 0;
      const overrideVal = overrides instanceof Map
        ? overrides.get(comboKey)
        : (overrides && Object.prototype.hasOwnProperty.call(overrides, comboKey) ? overrides[comboKey] : undefined);
      const qty = overrideVal !== undefined
        ? Math.max(0, Math.floor(Number.parseInt(String(overrideVal), 10) || 0))
        : generatedQty;
      entries.push({
        comboKey,
        color,
        size,
        attributes: { option_1: color, option_2: size },
        quantity: qty,
      });
      if (qty > 0) quantitiesMap.set(comboKey, qty);
    }
  }

  const totalPieces = entries.reduce((sum, item) => sum + item.quantity, 0);
  return {
    cartons: breakdown,
    totalCartons,
    sizes,
    colors: normalizedColors,
    options,
    entries,
    quantitiesMap,
    totalPieces,
    evenSplit: allEvenSplit,
  };
}

export function buildCartonNewProductPayload({
  name,
  sku,
  categoryId = null,
  unitCostMinor,
  retailPriceMinor = null,
  distribution,
  reorderPoint = '3',
}) {
  const cleanBaseSku = String(sku ?? 'CARTON').trim().toUpperCase().replace(/\s+/g, '-').slice(0, 38) || 'CARTON';
  const usedSkus = new Set();
  const variants = distribution.entries.map((entry, idx) => {
    const sizeToken = String(entry.size).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || String(idx + 1);
    const core = entry.color
      ? `${cleanBaseSku}-${encodeColorSkuToken(entry.color, idx + 1)}-${sizeToken}`
      : `${cleanBaseSku}-${sizeToken}`;
    let variantSku = core.slice(0, 60);
    let suffix = 2;
    while (usedSkus.has(variantSku.toLowerCase())) {
      variantSku = `${core.slice(0, 56)}-${suffix++}`;
    }
    usedSkus.add(variantSku.toLowerCase());
    return {
      sku: variantSku,
      attributes: { ...entry.attributes },
      quantity: String(entry.quantity),
      unitCost: String(unitCostMinor),
      ...(retailPriceMinor ? { retailPrice: String(retailPriceMinor) } : {}),
      reorderPoint: String(reorderPoint),
    };
  });

  const totalCostMinor = BigInt(unitCostMinor) * BigInt(distribution.totalPieces);
  return {
    product: {
      name: String(name ?? '').trim(),
      sku: String(sku ?? '').trim(),
      ...(categoryId ? { categoryId } : {}),
      options: distribution.options.map((opt) => ({
        key: opt.key,
        name: opt.name,
        values: [...opt.values],
      })),
      variants,
    },
    totalCostMinor,
  };
}

export function mergeDuplicateSkuNewProducts(newProducts) {
  const merged = [];
  const bySku = new Map();

  for (const item of newProducts) {
    const normSku = String(item.sku ?? '').trim().toUpperCase();
    const existing = bySku.get(normSku);
    if (!existing) {
      const cloned = {
        ...item,
        options: (item.options ?? []).map((opt) => ({ ...opt, values: [...opt.values] })),
        variants: (item.variants ?? []).map((variant) => ({
          ...variant,
          attributes: { ...(variant.attributes ?? {}) },
        })),
      };
      bySku.set(normSku, cloned);
      merged.push(cloned);
      continue;
    }

    const existingKeys = existing.options.map((opt) => `${opt.key}:${opt.name}`);
    const itemKeys = (item.options ?? []).map((opt) => `${opt.key}:${opt.name}`);
    if (
      existingKeys.length !== itemKeys.length ||
      existingKeys.some((entry, idx) => entry !== itemKeys[idx])
    ) {
      throw new Error(`عند تكرار كود الموديل (${normSku}) في نفس الفاتورة يجب أن تتطابق خيارات اللون والمقاس بين الكراتين`);
    }

    for (const opt of item.options ?? []) {
      const targetOpt = existing.options.find((entry) => entry.key === opt.key);
      if (!targetOpt) continue;
      for (const val of opt.values) {
        if (!targetOpt.values.includes(val)) targetOpt.values.push(val);
      }
    }

    const existingByCombo = new Map();
    const usedSkus = new Set();
    for (const variant of existing.variants) {
      const comboSig = existing.options.map((opt) => `${opt.key}=${variant.attributes?.[opt.key] ?? ''}`).join(':::');
      existingByCombo.set(comboSig, variant);
      usedSkus.add(String(variant.sku).toLowerCase());
    }

    for (const variant of item.variants ?? []) {
      const comboSig = existing.options.map((opt) => `${opt.key}=${variant.attributes?.[opt.key] ?? ''}`).join(':::');
      const targetVariant = existingByCombo.get(comboSig);
      if (targetVariant) {
        if (BigInt(targetVariant.unitCost) !== BigInt(variant.unitCost)) {
          throw new Error(`سعر الجملة يجب أن يكون متطابقًا لنفس الكود (${normSku}) داخل الفاتورة الواحدة`);
        }
        targetVariant.quantity = (BigInt(targetVariant.quantity) + BigInt(variant.quantity)).toString();
      } else {
        let nextSku = String(variant.sku);
        let counter = 2;
        while (usedSkus.has(nextSku.toLowerCase())) {
          nextSku = `${String(variant.sku).slice(0, 56)}-${counter++}`;
        }
        usedSkus.add(nextSku.toLowerCase());
        const clonedVariant = {
          ...variant,
          sku: nextSku,
          attributes: { ...(variant.attributes ?? {}) },
        };
        existing.variants.push(clonedVariant);
        existingByCombo.set(comboSig, clonedVariant);
      }
    }
  }

  return merged;
}
