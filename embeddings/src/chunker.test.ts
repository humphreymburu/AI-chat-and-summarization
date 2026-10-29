/**
 * Chunker unit tests.
 *
 * Run with: npx ts-node --transpileOnly chunker.test.ts
 *           or via your existing test runner (jest, vitest, etc.)
 *
 * Tests cover:
 *   - Short single-section news (World Ozone Day style)
 *   - Multi-section listicle ("5 ways to..." style)
 *   - Long single-section feature (needs secondary split)
 *   - Boilerplate detection (link-heavy "Previous campaigns" sections)
 *   - Heading propagation
 *   - Edge cases: empty body, no headings, decorative headings, tables, lists
 *   - Max-chunks safety cap
 */

import { chunkArticle, countTokens, ArticleDoc } from './chunker';

let testCount = 0;
let passCount = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`  ✗ ${name}\n    ${msg}`);
    console.log(`  ✗ ${name}\n    ${msg}`);
  }
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n      expected: ${JSON.stringify(expected)}\n      got:      ${JSON.stringify(actual)}`);
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseArticle: ArticleDoc = {
  _id: 'test-article-1',
  title: 'Test Article',
  body: '',
  langcode: 'en',
};

const worldOzoneDayArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'unenvironment-news_articles-3d088317-en',
  title: 'World Ozone Day, 16 September 2026',
  body: `<p><strong>WORLD OZONE DAY THEME - 2026: Global action for a cooler planet</strong><br>Celebrating 10 years of sustainable cooling under the Kigali Amendment to the Montreal Protocol.</p>
<img src="http://example.com/img.jpg" alt="WOD-6">
<p><strong>Global action for a cooler planet celebrates the Montreal Protocol and the transformative impact of its Kigali Amendment ten years after adoption.</strong> The Montreal Protocol has demonstrated that science based policy, universal participation, strong compliance, dedicated financing, and effective partnerships can deliver real and measurable results. Through these elements, the treaty has not only protected the ozone layer but also enabled countries and industries to transition to safer, more sustainable alternatives while supporting economic development. <a href="https://ozone.unep.org/ozone-day/global-action-cooler-planet">Continue reading...</a></p>
<p><strong>BACKGROUND TO WORLD OZONE DAY</strong></p>
<p>On 19 December 1994, the <a href="https://undocs.org/A/RES/49/114">United Nations General Assembly</a> proclaimed 16 September as the International Day for the Preservation of the Ozone Layer, commemorating the date in 1987 when the <a href="https://www.unenvironment.org/ozonaction/who-we-are/about-montreal-protocol">Montreal Protocol on Substances that Deplete the Ozone Layer</a> was signed.</p>
<p>States are invited to devote the Day each year to promote, at the national level, activities in accordance with the objectives of the Montreal Protocol and its amendments.</p>
<hr>
<p><strong>PREVIOUS WOD CAMPAIGNS</strong></p>
<p><a href="https://www.unep.org/2025">2025 World Ozone Day</a> <a href="https://www.unep.org/2024">2024 World Ozone Day</a> <a href="https://www.unep.org/2023">2023 World Ozone Day</a> <a href="https://www.unep.org/2022">2022 World Ozone Day</a> <a href="https://www.unep.org/2021">2021 World Ozone Day</a> <a href="https://www.unep.org/2020">2020 World Ozone Day</a></p>`,
};

const listicleArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'test-listicle',
  title: 'Here are five ways you can help heal the natural world',
  body: `<p>Biodiversity loss is accelerating worldwide. The UN Decade on Ecosystem Restoration calls for urgent action from individuals, communities, and governments. Here are five concrete actions you can take to support ecosystem recovery and protect biodiversity in your community.</p>
<h2>1. Reduce food waste</h2>
<p>Approximately one third of all food produced globally is lost or wasted, with significant emissions and biodiversity costs. Composting kitchen scraps, planning meals to use ingredients before they spoil, and supporting farms that practice regenerative agriculture all reduce the demand for new agricultural land. Industrial agriculture is a leading driver of habitat loss; cutting food waste cuts that pressure directly.</p>
<h2>2. Plant native species</h2>
<p>Native plants are the foundation of healthy ecosystems, providing food and shelter for pollinators including bees, butterflies, and birds. Replacing lawn with native flowering plants, removing invasive species, and supporting community garden projects all expand habitat. Local nurseries often stock native varieties specifically adapted to your region's soil and climate conditions.</p>
<h2>3. Support sustainable supply chains</h2>
<p>Many everyday products including coffee, chocolate, palm oil, beef, and timber are linked to deforestation. Look for certifications such as Rainforest Alliance, FSC, and MSC. Reducing consumption of these commodities, when possible, lowers demand pressure on tropical forests and marine ecosystems. Consumer choices, multiplied across millions of households, shift corporate sourcing decisions.</p>
<h2>4. Reduce plastic use</h2>
<p>Plastic pollution affects every ocean and most freshwater systems. Switching to reusable bags, bottles, and food containers cuts the steady leakage of single-use plastics into the environment. Supporting policies that ban or tax problematic single-use items amplifies individual action. Microplastics now appear in nearly every food chain, including human bodies.</p>
<h2>5. Speak up</h2>
<p>Individual lifestyle changes matter but policy change matters more. Contact elected representatives about climate and biodiversity legislation. Vote in local elections where land-use decisions are made. Join community groups working on environmental issues in your area. Civic engagement amplifies the impact of personal choices many times over.</p>
<p>The UN Decade on Ecosystem Restoration (2021-2030) brings together global efforts to prevent, halt, and reverse the degradation of ecosystems worldwide. Each individual action contributes to this collective effort.</p>`,
};

const longFeatureArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'test-long-feature',
  title: 'Coral reef restoration: a global progress report',
  body:
    '<h2>Introduction</h2>' +
    Array(8).fill(
      '<p>Coral reefs cover less than one percent of the ocean floor but support roughly a quarter of all marine species. Their continued decline due to ocean warming, acidification, pollution, and overfishing represents one of the most acute biodiversity crises of our time. This article surveys the state of reef restoration science as of 2026, drawing on field reports from twelve countries and synthesizing peer-reviewed research published over the past three years. Major initiatives in Australia, Indonesia, the Caribbean, and East Africa demonstrate that restoration is possible at meaningful scales, though the gap between current efforts and the scale of loss remains enormous.</p>'
    ).join(''),
};

const noHeadingsArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'test-no-headings',
  title: 'Brief news item',
  body: '<p>The United Nations Environment Programme announced today that it has reached an agreement with several major shipping companies to reduce emissions from international cargo transport by twenty percent by 2030. The agreement, which is non-binding but represents significant industry commitment, covers approximately forty percent of global cargo tonnage.</p>',
};

const decorativeHeadingArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'test-decorative',
  title: 'Climate finance update',
  body: `<h2>Photo:</h2>
<p>UNEP / Florian Fussstetter</p>
<p>Major progress was reported this week on the Loss and Damage Fund, with several donor countries confirming their pledges totaling over $700 million. The fund, established at COP28, provides financial support to vulnerable countries facing climate-induced losses.</p>
<p>Disbursements are expected to begin in late 2025, with priority given to small island developing states. The World Bank serves as interim trustee while governance arrangements are finalized.</p>`,
};

const emptyBodyArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'test-empty',
  title: 'Empty article',
  body: '',
};

const tableArticle: ArticleDoc = {
  ...baseArticle,
  _id: 'test-table',
  title: 'Emissions by region',
  body: `<p>The following table summarizes regional emissions as of 2025.</p>
<table>
  <tr><th>Region</th><th>Emissions (GtCO2)</th></tr>
  <tr><td>Asia-Pacific</td><td>22.4</td></tr>
  <tr><td>North America</td><td>6.1</td></tr>
  <tr><td>Europe</td><td>3.5</td></tr>
</table>
<p>These figures reflect the latest IPCC working group inventory.</p>`,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chunker: short single-section news (World Ozone Day)', () => {
  const chunks = chunkArticle(worldOzoneDayArticle);

  test('produces 1 chunk (boilerplate dropped)', () => {
    assertEqual(chunks.length, 1, 'expected single chunk after boilerplate removal');
  });

  test('chunk text includes article title', () => {
    assert(
      chunks[0].text.startsWith('World Ozone Day, 16 September 2026'),
      'chunk.text should start with the article title'
    );
  });

  test('chunk body excludes article title (no double-counting)', () => {
    assert(
      !chunks[0].body.startsWith('World Ozone Day'),
      'chunk.body should not start with the article title'
    );
  });

  test('chunk body does NOT contain the Previous WOD Campaigns links', () => {
    assert(
      !/2025 World Ozone Day/i.test(chunks[0].body),
      'Previous WOD Campaigns section should be detected as boilerplate and removed'
    );
  });

  test('chunk body contains the Kigali Amendment content', () => {
    assert(
      /Kigali Amendment/i.test(chunks[0].body),
      'main content should be preserved'
    );
  });

  test('low_content flag is false', () => {
    assertEqual(chunks[0].low_content, false, 'low_content should be false');
  });

  test('token_count is reasonable', () => {
    assert(
      chunks[0].token_count > 50 && chunks[0].token_count < 600,
      `expected 50 < token_count < 600, got ${chunks[0].token_count}`
    );
  });
});

describe('chunker: multi-section listicle (5 ways to heal)', () => {
  const chunks = chunkArticle(listicleArticle);

  test('produces multiple chunks (one per numbered section)', () => {
    assert(
      chunks.length >= 5 && chunks.length <= 7,
      `expected 5-7 chunks for listicle, got ${chunks.length}`
    );
  });

  test('chunks include their section heading in the embedded text', () => {
    const supplyChunk = chunks.find(c => /sustainable supply chains/i.test(c.section_heading));
    assert(supplyChunk, 'should have a chunk for "Support sustainable supply chains"');
    assert(
      /Support sustainable supply chains/i.test(supplyChunk!.text),
      'chunk.text should include the section heading'
    );
  });

  test('chunks index sequentially from 0', () => {
    chunks.forEach((c, i) => {
      assertEqual(c.chunk_index, i, `chunk at position ${i} should have chunk_index ${i}`);
    });
  });

  test('every chunk body is non-empty', () => {
    chunks.forEach((c, i) => {
      assert(c.body.length > 0, `chunk ${i} body is empty`);
    });
  });

  test('every chunk has a positive token count', () => {
    chunks.forEach((c, i) => {
      assert(c.token_count > 0, `chunk ${i} has zero tokens`);
    });
  });
});

describe('chunker: long single-section feature (secondary split needed)', () => {
  const chunks = chunkArticle(longFeatureArticle);

  test('produces multiple chunks despite single section', () => {
    assert(
      chunks.length >= 2,
      `expected secondary split to produce multiple chunks, got ${chunks.length}`
    );
  });

  test('no chunk exceeds maximum token cap (with small buffer for overlap)', () => {
    chunks.forEach((c, i) => {
      assert(
        c.token_count <= 700,
        `chunk ${i} exceeds max tokens: ${c.token_count}`
      );
    });
  });

  test('all chunks carry the same section heading', () => {
    const headings = new Set(chunks.map(c => c.section_heading));
    assertEqual(headings.size, 1, 'sub-chunks should share the parent section heading');
  });
});

describe('chunker: article with no headings', () => {
  const chunks = chunkArticle(noHeadingsArticle);

  test('produces at least 1 chunk', () => {
    assert(chunks.length >= 1, 'should produce at least one chunk');
  });

  test('chunks have empty section_heading', () => {
    chunks.forEach(c => assertEqual(c.section_heading, '', 'no heading expected'));
  });

  test('chunk text still includes article title', () => {
    assert(
      chunks[0].text.includes('Brief news item'),
      'chunk.text should include article title even without heading'
    );
  });
});

describe('chunker: decorative heading detection', () => {
  const chunks = chunkArticle(decorativeHeadingArticle);

  test('does not produce a tiny isolated chunk for "Photo:" heading', () => {
    const tinyPhoto = chunks.find(c => c.section_heading === 'Photo:' && c.token_count < 30);
    assert(!tinyPhoto, 'decorative "Photo:" heading should not produce a tiny isolated chunk');
  });

  test('main content about Loss and Damage Fund is present', () => {
    const main = chunks.find(c => /Loss and Damage Fund/i.test(c.body));
    assert(main, 'main content about Loss and Damage Fund should be present');
  });
});

describe('chunker: empty body', () => {
  const chunks = chunkArticle(emptyBodyArticle);

  test('produces zero chunks for empty body', () => {
    assertEqual(chunks.length, 0, 'empty body should produce no chunks');
  });
});

describe('chunker: table handling', () => {
  const chunks = chunkArticle(tableArticle);

  test('produces at least 1 chunk', () => {
    assert(chunks.length >= 1);
  });

  test('table data is converted to flat prose, not HTML', () => {
    const fullText = chunks.map(c => c.body).join(' ');
    assert(!/<table>/i.test(fullText), 'should not contain HTML table tags');
    assert(!/<tr>/i.test(fullText), 'should not contain HTML tr tags');
    assert(/Asia-Pacific/i.test(fullText), 'should preserve table row content as text');
  });
});

describe('chunker: max chunks safety cap', () => {
  const manySections = Array(30).fill(0).map((_, i) =>
    `<h2>Section ${i + 1}</h2><p>${'This is paragraph content for section ' + (i + 1) + '. '.repeat(60)}</p>`
  ).join('');

  const articleWithTooMany: ArticleDoc = {
    ...baseArticle,
    _id: 'test-many-sections',
    title: 'Article with many sections',
    body: manySections,
  };

  const chunks = chunkArticle(articleWithTooMany);

  test('respects MAX_CHUNKS_PER_ARTICLE cap (default 20)', () => {
    assert(chunks.length <= 20, `expected ≤ 20 chunks, got ${chunks.length}`);
  });
});

describe('chunker: custom options', () => {
  test('respects custom targetTokens', () => {
    const chunks = chunkArticle(listicleArticle, { targetTokens: 200, maxTokens: 300 });
    chunks.forEach((c, i) => {
      assert(
        c.token_count <= 400,
        `with custom maxTokens=300, chunk ${i} should be smaller: ${c.token_count}`
      );
    });
  });

  test('respects relaxed boilerplate detection (high threshold)', () => {
    const chunks = chunkArticle(worldOzoneDayArticle, { boilerplateLinkRatio: 0.99 });
    const hasOldLinks = chunks.some(c => /2025 World Ozone Day/i.test(c.body));
    assert(hasOldLinks, 'with relaxed boilerplate detection, links section should be kept');
  });
});

describe('countTokens', () => {
  test('returns 0 for empty string', () => {
    assertEqual(countTokens(''), 0);
  });

  test('returns positive count for non-empty text', () => {
    assert(countTokens('Hello world') > 0);
  });

  test('longer text has more tokens', () => {
    const short = countTokens('Hello');
    const long = countTokens('Hello world '.repeat(100));
    assert(long > short, 'longer text should have more tokens');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
console.log(`Tests: ${passCount}/${testCount} passed`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log('All tests passed.');