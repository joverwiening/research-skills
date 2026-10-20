/**
 * Offline tests for the pure half of getpaper.mjs: the accept/reject decisions
 * on fetched bodies. Fixtures are trimmed from bodies the fetcher received.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isBotChallenge, isDownloadInterstitial, hasArticleBody, pmcVersionFrom, sniffPreprint,
  parseInput, markupToText, slug, dspaceRestUrl, findPdfLink, arxivCandidates, redact,
  elifeCandidates, hasPdfTrailer, titleMatches, normTitle, parseArxivFeed, openreviewTitleFrom,
  biorxivCandidatesFrom, pmcidCandidates, metaPdfUrl, fromOpenalexWork, cleanTitle, zenodoFileUrls,
  parseArgs, isShortText,
} from '../getpaper.mjs';

describe('isBotChallenge', () => {
  it('catches the Cloudflare interstitial', () => {
    assert.equal(isBotChallenge('<html><head><title>Just a moment...</title></head></html>'), true);
    assert.equal(isBotChallenge('<div class="cf-browser-verification"></div>'), true);
  });
  it('catches cookie walls', () => {
    assert.equal(isBotChallenge('Please Enable JavaScript and cookies to continue'), true);
    assert.equal(isBotChallenge('https://journals.sagepub.com/?error=cookies_not_supported'), true);
  });
  it('does not fire on an article that merely says "moment"', () => {
    assert.equal(isBotChallenge('<p>At the moment of stimulus onset, firing rates rose.</p>'), false);
  });
});

describe('isDownloadInterstitial', () => {
  it('catches the short PMC download shim', () => {
    assert.equal(isDownloadInterstitial('<html><body><h1>Preparing to download...</h1></body></html>'), true);
  });
  it('is length-bounded so a real article containing the phrase survives', () => {
    const article = 'Preparing to download the dataset, we first ' + 'x'.repeat(9000);
    assert.equal(isDownloadInterstitial(article), false);
  });
});

describe('hasArticleBody', () => {
  it('accepts JATS with a body', () => {
    assert.equal(hasArticleBody('<article><front>..</front><body><p>text</p></body></article>'), true);
    assert.equal(hasArticleBody('<body specific-use="x"><p/></body>'), true);
  });
  // A paper with many authors and references clears any length floor on
  // front matter alone.
  it('rejects a front-matter-only metadata record', () => {
    const frontOnly = '<article><front><article-meta><title-group><article-title>T</article-title>'
      + '</title-group><contrib-group>' + '<contrib><name>A</name></contrib>'.repeat(300)
      + '</contrib-group></article-meta></front></article>';
    assert.ok(frontOnly.length > 5000);
    assert.equal(hasArticleBody(frontOnly), false);
  });
  it('does not match a tag that merely starts with "body"', () => {
    assert.equal(hasArticleBody('<bodyweight>70kg</bodyweight>'), false);
  });
});

describe('pmcVersionFrom', () => {
  // The warning that wording and pagination differ from the journal.
  it('flags author-manuscript deposits', () => {
    assert.equal(pmcVersionFrom('<article-id pub-id-type="manuscript">NIHMS123</article-id>'), 'acceptedVersion');
    assert.equal(pmcVersionFrom('HHS Public Access\nAuthor manuscript'), 'acceptedVersion');
  });
  it('leaves a version-of-record deposit alone', () => {
    assert.equal(pmcVersionFrom('<article-id pub-id-type="pmc">PMC123</article-id><body/>'), 'publishedVersion');
  });
});

describe('sniffPreprint', () => {
  it('reads the banner in the first 2 kB', () => {
    assert.equal(sniffPreprint('bioRxiv preprint doi: https://doi.org/10.1101/xxx'), 'preprint');
    assert.equal(sniffPreprint('  medRxiv preprint\n'), 'preprint');
  });
  it('ignores the phrase past the banner zone', () => {
    assert.equal(sniffPreprint('x'.repeat(3000) + 'bioRxiv preprint'), null);
  });
  it('returns null for an ordinary paper', () => {
    assert.equal(sniffPreprint('Journal of Neuroscience, 2014'), null);
  });
});

describe('parseInput', () => {
  it('parses arXiv ids in all three shapes', () => {
    assert.deepEqual(parseInput('2502.08235'), { kind: 'arxiv', id: '2502.08235' });
    assert.deepEqual(parseInput('arXiv:2502.08235v3'), { kind: 'arxiv', id: '2502.08235v3' });
    assert.deepEqual(parseInput('cond-mat/0501234'), { kind: 'arxiv', id: 'cond-mat/0501234' });
    assert.deepEqual(parseInput('q-bio.NC/0601001'), { kind: 'arxiv', id: 'q-bio.NC/0601001' });
  });
  it('routes the arXiv DOI to the arXiv rungs, keeping the DOI', () => {
    assert.deepEqual(parseInput('10.48550/arXiv.2502.08235'),
      { kind: 'arxiv', id: '2502.08235', doi: '10.48550/arXiv.2502.08235' });
  });
  it('parses arxiv.org URLs', () => {
    assert.deepEqual(parseInput('https://arxiv.org/abs/2502.08235'), { kind: 'arxiv', id: '2502.08235' });
    assert.deepEqual(parseInput('https://www.arxiv.org/pdf/2502.08235.pdf'), { kind: 'arxiv', id: '2502.08235' });
  });
  it('keeps a SICI DOI whole', () => {
    const sici = '10.1002/(SICI)1096-9861(19960101)364:1<6::AID-CNE2>3.0.CO;2-9';
    assert.deepEqual(parseInput(sici), { kind: 'doi', doi: sici });
  });
  it('extracts an embedded DOI and strips trailing sentence punctuation', () => {
    assert.deepEqual(parseInput('https://doi.org/10.1038/nn.3807'), { kind: 'doi', doi: '10.1038/nn.3807' });
    assert.deepEqual(parseInput('(see https://doi.org/10.1038/nn.3807).'), { kind: 'doi', doi: '10.1038/nn.3807' });
  });
  it('falls back to url, then unknown', () => {
    assert.deepEqual(parseInput('https://example.org/paper.html'), { kind: 'url', url: 'https://example.org/paper.html' });
    assert.deepEqual(parseInput('Hebb 1949'), { kind: 'unknown', raw: 'Hebb 1949' });
  });
});

describe('markupToText', () => {
  it('drops script/style/head wholesale, not just their tags', () => {
    assert.equal(markupToText('<head><title>T</title></head><p>Body.</p>'), 'Body.');
    assert.equal(markupToText('<script>var x = "<p>fake</p>";</script><p>Real.</p>'), 'Real.');
  });
  it('decodes the entities that show up in JATS', () => {
    assert.equal(markupToText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>'), 'a & b <c> "d" \'e\'');
  });
  // Paragraph separation survives; the stray space each stripped tag leaves at
  // a line end does not get trimmed, which is fine for quoting but would break
  // a naive round-trip comparison.
  it('collapses runs of blank lines to one', () => {
    assert.equal(markupToText('<p>a</p>\n\n\n\n<p>b</p>'), 'a \n\n b');
  });
});

describe('slug', () => {
  it('is filesystem-safe, length-capped, and collision-resistant', () => {
    const s = slug('10.1002/(SICI)1096-9861(19960101)364:1<6::AID-CNE2>3.0.CO;2-9');
    assert.match(s, /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
    assert.ok(s.length <= 89);
    assert.equal(slug('10.1038/nn.3807'), slug('10.1038/nn.3807'));
    assert.notEqual(slug('a'.repeat(200)), slug('a'.repeat(199)));
  });
});

describe('dspaceRestUrl', () => {
  it('rewrites a DSpace 7 bitstream link to the REST content route', () => {
    assert.equal(dspaceRestUrl('https://repo.example.edu/bitstreams/0f1e2d3c-4b5a-6978-8765-4321fedcba09/download'),
      'https://repo.example.edu/server/api/core/bitstreams/0f1e2d3c-4b5a-6978-8765-4321fedcba09/content');
  });
  it('leaves anything else alone', () => {
    assert.equal(dspaceRestUrl('https://repo.example.edu/handle/1234/5678'), null);
  });
});

describe('findPdfLink', () => {
  const base = 'https://repo.example.edu/item/42';
  it('prefers an explicit .pdf href and resolves it against the base', () => {
    assert.equal(findPdfLink('<a href="files/paper.pdf">PDF</a><a href="/download/9">alt</a>', base),
      'https://repo.example.edu/item/files/paper.pdf');
  });
  it('falls back to a download-shaped path, then /document', () => {
    assert.equal(findPdfLink('<a href="/bitstream/9/1">get</a>', base), 'https://repo.example.edu/bitstream/9/1');
    assert.equal(findPdfLink('<a href="/hal-042/document">get</a>', base), 'https://repo.example.edu/hal-042/document');
  });
  it('returns null when the landing page has no file link', () => {
    assert.equal(findPdfLink('<a href="/about">about</a>', base), null);
  });
});

describe('arxivCandidates', () => {
  it('keeps the version for the PDF and strips it for ar5iv', () => {
    const [pdf, html] = arxivCandidates('2502.08235v3');
    assert.equal(pdf.url, 'https://arxiv.org/pdf/2502.08235v3');
    assert.equal(html.url, 'https://ar5iv.labs.arxiv.org/html/2502.08235');
    assert.equal(html.trustedMarkup, true);
  });
});

describe('elifeCandidates', () => {
  it('drops the version suffix and fires only on eLife DOIs', () => {
    assert.equal(elifeCandidates('10.7554/eLife.110287.1')[0].url,
      'https://api.elifesciences.org/reviewed-preprints/110287');
    assert.equal(elifeCandidates('10.7554/elife.10989').length, 1);
    assert.deepEqual(elifeCandidates('10.1038/nn.3807'), []);
  });
  it('labels the copy so the version warning fires', () => {
    assert.equal(elifeCandidates('10.7554/eLife.110287.1')[0].oaVersion, 'reviewedPreprint');
  });
  // The envelope is ~2 kB of JSON punctuation even when the article field is
  // absent, so without a null here an error payload would clear the floor.
  it('unwraps indexContent and rejects an envelope without it', () => {
    const { unwrap } = elifeCandidates('10.7554/eLife.110287.1')[0];
    assert.equal(unwrap('{"indexContent":"<p>Introduction</p>"}'), '<p>Introduction</p>');
    assert.equal(unwrap('{"title":"T","status":"reviewed"}'), null);
    assert.equal(unwrap('<html>not json</html>'), null);
  });
});

/**
 * Why pdftotext runs WITHOUT -layout for the copy that gets quoted.
 *
 * -layout reproduces the physical page, so a two-column paper comes out with
 * both columns on one line and a quote lifted from it splices two unrelated
 * sentences while still reading as verbatim. The
 * fixture below is a hand-built uncompressed PDF with two text columns, so the
 * decision is tested rather than asserted in a comment.
 */
function twoColumnPdf() {
  const LEFT = [
    'We show that incorporating learnable membrane',
    'time constants can make the network less',
    'sensitive to initial values and can speed up',
    'learning across every dataset we tried here.',
  ];
  const RIGHT = [
    'generation of neural network models, which',
    'are closer to the biological substrate than',
    'the rate-coded units used by conventional',
    'deep networks trained with backpropagation.',
  ];
  let content = '';
  LEFT.forEach((t, i) => { content += `BT /F1 10 Tf 1 0 0 1 60 ${700 - i * 14} Tm (${t}) Tj ET\n`; });
  RIGHT.forEach((t, i) => { content += `BT /F1 10 Tf 1 0 0 1 330 ${700 - i * 14} Tm (${t}) Tj ET\n`; });
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

describe('pdf column handling', () => {
  const PDFTOTEXT = 'pdftotext';
  let missing = false;
  try { execFileSync(PDFTOTEXT, ['-v'], { stdio: 'ignore' }); } catch (e) { missing = e.code === 'ENOENT'; }
  const extract = (flags) => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-col-'));
    const pdf = join(dir, 'f.pdf');
    const txt = join(dir, 'f.txt');
    writeFileSync(pdf, twoColumnPdf(), 'latin1');
    execFileSync(PDFTOTEXT, [...flags, pdf, txt]);
    return readFileSync(txt, 'utf8');
  };
  const SENTENCE = 'can make the network less sensitive to initial values and can speed up learning';

  it('reading-order mode keeps a sentence whole across a column break', { skip: missing && 'pdftotext not on PATH' }, () => {
    const text = extract([]);
    assert.ok(text.replace(/\s+/g, ' ').includes(SENTENCE));
    assert.equal(text.split('\n').some((l) => /membrane.*generation of neural/.test(l)), false);
  });

  // This is the failure the fix exists for, pinned so a future edit that puts
  // -layout back on the quoting path fails here instead of in a citation.
  it('-layout mode splices the two columns onto one line', { skip: missing && 'pdftotext not on PATH' }, () => {
    const text = extract(['-layout']);
    assert.ok(!text.replace(/\s+/g, ' ').includes(SENTENCE));
    assert.equal(text.split('\n').some((l) => /membrane\s{2,}generation of neural/.test(l)), true);
  });
});

describe('redact', () => {
  it('strips whichever publisher key is loaded', () => {
    const key = process.env.SPRINGER_OA_API_KEY || process.env.NCBI_API_KEY;
    if (!key) return; // no key loaded; nothing to assert
    assert.ok(!redact(`https://api.example.org/openaccess/jats?api_key=${key}`).includes(key));
    assert.equal(redact(`api_key=${key}`), 'api_key=<api_key>');
  });
  it('passes through a string with no key in it', () => {
    assert.equal(redact('https://api.crossref.org/works/10.1038/nn.3807'), 'https://api.crossref.org/works/10.1038/nn.3807');
  });
});

describe('parseInput — more routes', () => {
  it('treats a scheme-less URL as https', () => {
    assert.deepEqual(parseInput('arxiv.org/abs/2509.13978'), { kind: 'arxiv', id: '2509.13978' });
    assert.deepEqual(parseInput('www.example.org/paper.html'), { kind: 'url', url: 'https://www.example.org/paper.html' });
    assert.deepEqual(parseInput('pmc.ncbi.nlm.nih.gov/articles/PMC4472377/'), { kind: 'pmcid', pmcid: 'PMC4472377' });
  });
  it('parses every arXiv URL form, keeping versions', () => {
    for (const [u, id] of [
      ['https://arxiv.org/html/2509.13978v2', '2509.13978v2'],
      ['https://arxiv.org/pdf/2509.13978v1', '2509.13978v1'],
      ['https://export.arxiv.org/abs/2509.13978', '2509.13978'],
      ['https://ar5iv.labs.arxiv.org/html/2509.13978', '2509.13978'],
      ['https://ar5iv.org/html/1706.03762', '1706.03762'],
      ['https://arxiv.org/abs/cond-mat/0501234', 'cond-mat/0501234'],
    ]) assert.deepEqual(parseInput(u), { kind: 'arxiv', id });
  });
  it('parses PMCIDs, bare and in PMC / Europe PMC URLs', () => {
    for (const u of [
      'PMC4472377', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4472377/',
      'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4472377/', 'https://europepmc.org/article/PMC/PMC4472377',
      'https://europepmc.org/articles/PMC4472377', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4472377/pdf/nihms641645.pdf',
    ]) assert.deepEqual(parseInput(u), { kind: 'pmcid', pmcid: 'PMC4472377' });
    assert.deepEqual(parseInput('https://www.ebi.ac.uk/europepmc/webservices/rest/PMC12974486/fullTextXML'),
      { kind: 'pmcid', pmcid: 'PMC12974486' });
  });
  it('parses PubMed URLs to a PMID', () => {
    assert.deepEqual(parseInput('https://pubmed.ncbi.nlm.nih.gov/26097268/'), { kind: 'pmid', pmid: '26097268' });
    assert.deepEqual(parseInput('https://europepmc.org/article/MED/26097268'), { kind: 'pmid', pmid: '26097268' });
  });
  it('parses OpenReview forum/pdf URLs and openreview:, not bare ids', () => {
    assert.deepEqual(parseInput('https://openreview.net/forum?id=HpUDi5Pe8S'), { kind: 'openreview', id: 'HpUDi5Pe8S' });
    assert.deepEqual(parseInput('https://openreview.net/pdf?id=HkXKUTVFl'), { kind: 'openreview', id: 'HkXKUTVFl' });
    assert.deepEqual(parseInput('openreview:HkXKUTVFl'), { kind: 'openreview', id: 'HkXKUTVFl' });
    assert.equal(parseInput('HkXKUTVFl').kind, 'unknown');
  });
  it('takes the title from a ResearchGate slug', () => {
    assert.deepEqual(parseInput('https://www.researchgate.net/publication/230682228_Self-Complexity_and_Well-Being_A_Review_and_Research_Synthesis'),
      { kind: 'researchgate', title: 'Self-Complexity and Well-Being A Review and Research Synthesis' });
    assert.equal(parseInput('https://www.researchgate.net/profile/Jane_Doe/publication/123_Some_Title').title, 'Some Title');
  });
  it('parses OSF preprint URLs and PsyArXiv DOIs', () => {
    assert.deepEqual(parseInput('https://osf.io/preprints/psyarxiv/vf3se_v2'), { kind: 'osf', id: 'vf3se_v2' });
    assert.deepEqual(parseInput('osf.io/uv673'), { kind: 'osf', id: 'uv673' });
    assert.deepEqual(parseInput('10.31234/osf.io/uv673'), { kind: 'osf', id: 'uv673', doi: '10.31234/osf.io/uv673' });
    assert.equal(parseInput('https://doi.org/10.31234/osf.io/uv673').kind, 'osf');
  });
});

describe('markupToText — headings and breaks', () => {
  it('turns JATS sec titles into ## lines, label included', () => {
    const t = markupToText('<sec id="s2"><label>2.1</label><title>Methods</title><p>We did.</p><p>More.</p></sec>');
    assert.match(t, /^## 2\.1 Methods\n/);
    assert.ok(t.split('\n').length > 2);
  });
  it('turns TEI <head> into a heading but still drops an HTML <head>', () => {
    assert.match(markupToText('<div><head n="3">Results</head><p>R</p></div>'), /^## Results\n/);
    assert.equal(markupToText('<head><meta charset="utf-8"><title>T</title></head><p>Body.</p>'), 'Body.');
  });
  it('turns h1-h6 into headings and <br> into a newline', () => {
    assert.equal(markupToText('<h2 class="x">Intro</h2>line<br/>next'), '## Intro\nline \nnext');
  });
});

describe('hasPdfTrailer', () => {
  it('accepts a complete PDF and rejects a truncated one', () => {
    assert.equal(hasPdfTrailer(Buffer.from(twoColumnPdf(), 'latin1')), true);
    assert.equal(hasPdfTrailer(Buffer.from(twoColumnPdf().slice(0, 300), 'latin1')), false);
  });
});

describe('title matching', () => {
  it('matches exactly after normalization', () => {
    assert.equal(normTitle('Self-Complexity and Well-Being: A Review'), 'selfcomplexityandwellbeingareview');
    assert.equal(titleMatches('Attention Is All You Need', 'attention is all you need'), true);
    assert.equal(titleMatches('Not All Attention Is All You Need', 'Attention Is All You Need'), false);
  });
  it('accepts a prefix only for a long truncated slug', () => {
    const full = 'Self-Complexity and Well-Being: A Review and Research Synthesis';
    assert.equal(titleMatches(full, 'Self-Complexity and Well-Being A Review', { prefix: true }), true);
    assert.equal(titleMatches(full, 'Self-Complexity', { prefix: true }), false);
    assert.equal(titleMatches(full, 'Self-Complexity and Well-Being A Review'), false);
  });
  it('parses arXiv Atom entries, dropping the version', () => {
    const xml = '<feed><title>arXiv Query</title><entry><id>http://arxiv.org/abs/1706.03762v7</id>'
      + '<title>Attention Is All\n  You Need</title></entry></feed>';
    assert.deepEqual(parseArxivFeed(xml), [{ id: '1706.03762', title: 'Attention Is All You Need' }]);
  });
  it('reads the OpenReview title from api2 {value} and api v1 strings', () => {
    assert.equal(openreviewTitleFrom({ notes: [{ content: { title: { value: 'T2' } } }] }), 'T2');
    assert.equal(openreviewTitleFrom({ notes: [{ content: { title: 'T1' } }] }), 'T1');
    assert.equal(openreviewTitleFrom({ notes: [] }), null);
  });
});

describe('route candidates', () => {
  it('bioRxiv: latest version, JATS then PDF, labelled preprint', () => {
    const c = biorxivCandidatesFrom('biorxiv', '10.1101/681700', { collection: [
      { version: '1', jatsxml: 'https://x/v1.source.xml' }, { version: '2', jatsxml: 'https://x/v2.source.xml' }] });
    assert.deepEqual(c.map((x) => x.url), ['https://x/v2.source.xml', 'https://www.biorxiv.org/content/10.1101/681700v2.full.pdf']);
    assert.equal(c.every((x) => x.oaVersion === 'preprint'), true);
    assert.equal(c[0].requireBody, true);
    assert.deepEqual(biorxivCandidatesFrom('medrxiv', '10.1101/1', { collection: [] }), []);
  });
  it('PMCID: europepmc-xml only when OA, efetch and pmc-pdf always', () => {
    assert.deepEqual(pmcidCandidates('PMC1', false).map((x) => x.label), ['ncbi-efetch-jats', 'pmc-pdf']);
    assert.deepEqual(pmcidCandidates('PMC1', true).map((x) => x.label), ['europepmc-xml', 'ncbi-efetch-jats', 'pmc-pdf']);
  });
});

describe('OpenAlex inputs and works', () => {
  it('parses bare and URL W-ids', () => {
    assert.deepEqual(parseInput('W3171259667'), { kind: 'openalex', id: 'W3171259667' });
    assert.deepEqual(parseInput('w3171259667'), { kind: 'openalex', id: 'W3171259667' });
    assert.deepEqual(parseInput('https://openalex.org/W3171259667'), { kind: 'openalex', id: 'W3171259667' });
    assert.deepEqual(parseInput('https://api.openalex.org/works/W3171259667'), { kind: 'openalex', id: 'W3171259667' });
    assert.equal(parseInput('Wabc').kind, 'unknown');
  });
  it('extracts doi, arXiv id, clean title and location lists', () => {
    const w = fromOpenalexWork({
      id: 'https://openalex.org/W7098352517',
      doi: 'https://doi.org/10.1000/xyz.1',
      title: 'Random feedback weights support learning in deep neural networks Preprint at http://arxiv.org/abs',
      locations: [
        { landing_page_url: 'https://doi.org/10.1000/xyz.1', pdf_url: null },
        { landing_page_url: 'https://arxiv.org/abs/1411.0247v2', pdf_url: 'https://arxiv.org/pdf/1411.0247v2' },
        { landing_page_url: 'https://repo.example.edu/rec/9', pdf_url: 'https://repo.example.edu/rec/9/file.pdf' },
      ],
    });
    assert.equal(w.id, 'W7098352517');
    assert.equal(w.doi, '10.1000/xyz.1');
    assert.equal(w.arxiv, '1411.0247');
    assert.equal(w.title, 'Random feedback weights support learning in deep neural networks');
    assert.deepEqual(w.pdfUrls, ['https://arxiv.org/pdf/1411.0247v2', 'https://repo.example.edu/rec/9/file.pdf']);
    assert.deepEqual(w.landingUrls, ['https://doi.org/10.1000/xyz.1', 'https://arxiv.org/abs/1411.0247v2', 'https://repo.example.edu/rec/9']);
  });
  it('handles a work with no doi, no arXiv and no locations', () => {
    const w = fromOpenalexWork({ id: 'https://openalex.org/W1', title: 'Plain title' });
    assert.equal(w.doi, null);
    assert.equal(w.arxiv, null);
    assert.equal(w.title, 'Plain title');
    assert.deepEqual(w.pdfUrls, []);
    assert.deepEqual(w.landingUrls, []);
  });
  it('cleanTitle leaves ordinary titles alone', () => {
    assert.equal(cleanTitle('Align, then memorise: the dynamics of learning with feedback alignment*'),
      'Align, then memorise: the dynamics of learning with feedback alignment*');
    assert.equal(cleanTitle('A title https://example.org/x'), 'A title');
  });
});

describe('landing-page meta PDF', () => {
  const base = 'https://webthesis.biblio.polito.it/10994/';
  it('reads citation_pdf_url and eprints.document_url in either attribute order', () => {
    assert.equal(metaPdfUrl('<meta name="citation_pdf_url" content="/a.pdf">', base), 'https://webthesis.biblio.polito.it/a.pdf');
    assert.equal(metaPdfUrl('<meta content="https://x.org/b.pdf" name="citation_pdf_url" />', base), 'https://x.org/b.pdf');
    assert.equal(metaPdfUrl('<meta name="eprints.document_url" content="https://x.org/c.pdf" />', base), 'https://x.org/c.pdf');
    assert.equal(metaPdfUrl("<meta content='https://x.org/d.pdf' name='eprints.document_url'>", base), 'https://x.org/d.pdf');
    assert.equal(metaPdfUrl('<meta name="citation_title" content="T">', base), null);
  });
  it('findPdfLink prefers the meta URL over an earlier .pdf thumbnail href', () => {
    const html = '<html><head><meta name="eprints.document_url" content="https://webthesis.biblio.polito.it/10994/1/tesi.pdf" />'
      + '</head><body><a href="https://webthesis.biblio.polito.it/10994/1.haspreviewThumbnailVersion/tesi.pdf"><img></a>'
      + '<a href="https://webthesis.biblio.polito.it/10994/1/tesi.pdf">tesi.pdf</a></body></html>';
    assert.equal(findPdfLink(html, base), 'https://webthesis.biblio.polito.it/10994/1/tesi.pdf');
  });
  it('maps a DSpace download URL to its REST URL', () => {
    const html = '<meta name="citation_pdf_url" content="https://repo.example.edu/bitstreams/0f1e2d3c-4b5a-6978-8765-4321fedcba09/download">';
    assert.equal(findPdfLink(html, 'https://repo.example.edu/x'),
      'https://repo.example.edu/server/api/core/bitstreams/0f1e2d3c-4b5a-6978-8765-4321fedcba09/content');
  });
});

describe('zenodoFileUrls', () => {
  it('lists file links with PDFs first', () => {
    const rec = { files: [
      { key: 'code.zip', links: { self: 'https://zenodo.org/api/records/1/files/code.zip/content' } },
      { key: 'paper.pdf', links: { self: 'https://zenodo.org/api/records/1/files/paper.pdf/content' } },
      { key: 'nolink.pdf', links: {} },
    ] };
    assert.deepEqual(zenodoFileUrls(rec), [
      'https://zenodo.org/api/records/1/files/paper.pdf/content',
      'https://zenodo.org/api/records/1/files/code.zip/content',
    ]);
    assert.deepEqual(zenodoFileUrls({}), []);
  });
});

describe('parseArgs', () => {
  it('orders the positional id first, then each --also', () => {
    assert.deepEqual(parseArgs(['10.1/x', '--also', 'W1', '--also=W2']), { inputs: ['10.1/x', 'W1', 'W2'] });
    assert.deepEqual(parseArgs(['--also', 'W1', '10.1/x']), { inputs: ['10.1/x', 'W1'] });
    assert.deepEqual(parseArgs(['W1']), { inputs: ['W1'] });
  });
  it('rejects malformed argv', () => {
    assert.ok(parseArgs([]).error);
    assert.ok(parseArgs(['W1', '--also']).error);
    assert.ok(parseArgs(['W1', 'W2']).error);
    assert.ok(parseArgs(['W1', '--nope']).error);
    assert.equal(parseArgs(['--help']).help, true);
  });
});

describe('isShortText', () => {
  it('flags texts under 8000 chars', () => {
    assert.equal(isShortText(6000), true);
    assert.equal(isShortText(7999), true);
    assert.equal(isShortText(8000), false);
  });
});
