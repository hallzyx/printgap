Third-party libraries used by the chat (site/chat.js). Vendored so the site works offline and
never depends on a CDN. Files are the unmodified upstream builds from the npm packages, fetched from
https://cdn.jsdelivr.net/npm/<package>@<version>/... on 2026-10-08. No build step, no node_modules.

package      version   files                                        license
marked       18.1.0    marked/marked.umd.js (lib/marked.umd.js)     MIT                       marked/LICENSE
dompurify    3.4.16    dompurify/purify.min.js (dist/)              MPL-2.0 OR Apache-2.0     dompurify/LICENSE, LICENSE-MPL
katex        0.19.0    katex/katex.min.js, katex/katex.min.css,     MIT                       katex/LICENSE
                       katex/fonts/*.woff2 (dist/fonts, woff2 only;
                       every browser that runs this site reads woff2)
mermaid      12.1.0    mermaid/mermaid.min.js (dist/, UMD build)    MIT                       mermaid/LICENSE

Loading: marked + DOMPurify load when the chat is first opened (about 76 KB). KaTeX loads the first time an
answer contains math, mermaid (about 5.5 MB) the first time an answer contains a ```mermaid block.

sha256
f424dcb508fdf93e0137a970cfce8f3207ea2e3f37eca5f7556a52875683632a  marked/marked.umd.js
2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2  dompurify/purify.min.js
103a53763cc033bba8d175bf3f0ba597c3505c9b6747dd3f2c7bc2a6bfcc8ae7  katex/katex.min.js
d4ab5b8ee16989b070cdb0ea24bd6ad48fc8df1b787f280f29d3ae4f959f2c00  katex/katex.min.css
6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2  mermaid/mermaid.min.js

To update: download the same paths for the new version, replace the files, update this table and the hashes,
then run node tests/test_richtext.js and open the chat with a table, a formula, a chart and a diagram.
