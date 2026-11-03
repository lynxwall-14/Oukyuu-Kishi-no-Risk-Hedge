//=============================================================================
// TextFit_Oukyu.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc Keeps translated text inside its window (wrap, pagination, fitting). Load LAST.
 * @author translation patch
 *
 * @param messageWrap
 * @text Dialogue: word wrap
 * @desc Wrap a dialogue line only when it is wider than the visible area. Font size is never reduced.
 * @type boolean
 * @default true
 *
 * @param messageRightMargin
 * @text Dialogue: right margin
 * @desc Pixels kept free at the right edge (left margin 4 + outline/glyph overhang 3).
 * @type number
 * @default 7
 *
 * @param reflowToolBreaks
 * @text Dialogue: reflow tool line breaks
 * @desc Re-join explicit line breaks that match the translation tool's greedy wrap, then wrap to the real width.
 * @type boolean
 * @default false
 *
 * @param toolBreakColumns
 * @text Tool wrap columns
 * @desc Column count the translation tool wrapped at (a break is "tool-made" when the next word would not fit in it).
 * @type number
 * @default 60
 *
 * @param carryStyle
 * @text Dialogue: keep style on next page
 * @desc A continuation page keeps the current colour, size and outline instead of resetting them.
 * @type boolean
 * @default true
 *
 * @param scrollTextWrap
 * @text Scrolling text: word wrap
 * @type boolean
 * @default true
 *
 * @param scrollRightMargin
 * @text Scrolling text: right margin
 * @desc Pixels kept free at the right edge of the text area (its left padding 8 + 3).
 * @type number
 * @default 11
 *
 * @param choiceFit
 * @text Choices: fit in cell
 * @type boolean
 * @default true
 *
 * @param labelFit
 * @text Labels: cap compression
 * @desc Single-line labels drawn with a max width: allow up to maxCompression, then reduce the font.
 * @type boolean
 * @default true
 *
 * @param maxCompression
 * @text Max horizontal compression
 * @type number
 * @decimals 2
 * @default 1.25
 *
 * @param minFontRatio
 * @text Minimum font ratio
 * @desc Never shrink below this fraction of the normal size.
 * @type number
 * @decimals 2
 * @default 0.60
 *
 * @param dtextFit
 * @text Text pictures: keep on screen
 * @desc DTextPicture texts that would leave the screen are fitted (wrap, then smaller font) inside their own block.
 * @type boolean
 * @default true
 *
 * @param dtextMode
 * @text Text pictures: fitting mode
 * @desc block = shrink the whole picture; line = shrink only the overflowing line; compress = squeeze that line (max compression).
 * @type select
 * @option block
 * @option line
 * @option compress
 * @default block
 *
 * @param dtextRightMargin
 * @text Text pictures: right margin
 * @type number
 * @default 6
 *
 * @help
 * Translation display fix for this game only (RPG Maker MZ 1.9.0, NW.js 0.48.4).
 *
 * - Dialogue keeps its normal size. A line wider than the visible area wraps
 *   between words (or between graphemes for an over-long word); when the
 *   window is full, the rest continues on a new page after the usual
 *   confirmation. Continuation pages keep the current style; \> survives an
 *   automatic break; explicit line breaks are kept unless reflowToolBreaks.
 * - Scrolling text wraps the same way.
 * - Choices and single-line labels: up to 25% horizontal compression, then a
 *   smaller font (never below minFontRatio).
 * - DTextPicture texts stay on screen, inside their original height.
 *
 * Measurements use a private bitmap: no window, no escape code is executed.
 * No data, event or engine file is modified.
 */

(() => {
    "use strict";
    const PLUGIN = "TextFit_Oukyu";
    const P = PluginManager.parameters(PLUGIN);
    const bool = (v, d) => (v === undefined || v === "" ? d : String(v) === "true");
    const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
    const CFG = {
        messageWrap: bool(P.messageWrap, true),
        messageRightMargin: num(P.messageRightMargin, 7),
        reflow: bool(P.reflowToolBreaks, false),
        toolCols: num(P.toolBreakColumns, 60),
        carryStyle: bool(P.carryStyle, true),
        scrollTextWrap: bool(P.scrollTextWrap, true),
        scrollRightMargin: num(P.scrollRightMargin, 11),
        choiceFit: bool(P.choiceFit, true),
        labelFit: bool(P.labelFit, true),
        maxCompression: num(P.maxCompression, 1.25),
        minFontRatio: num(P.minFontRatio, 0.6),
        dtextFit: bool(P.dtextFit, true),
        dtextMode: String(P.dtextMode || "block"),
        dtextRightMargin: num(P.dtextRightMargin, 6)
    };
    const MAX_ITER = 2000;

    //-------------------------------------------------------------------------
    // Graphemes (no Intl.Segmenter in Chromium 85)
    //-------------------------------------------------------------------------
    let GRAPHEME;
    try {
        const ext = "\\p{M}\\u200d\\ufe00-\\ufe0f\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}";
        GRAPHEME = new RegExp(
            "[\\u{1F1E6}-\\u{1F1FF}]{2}" +
                "|(?:[^\\x00-\\x1f" + ext + "])(?:[" + ext.replace("\\u200d", "") + "]|\\u200d[^\\x00-\\x1f])*" +
                "|[\\s\\S]",
            "uy"
        );
    } catch (e) {
        GRAPHEME = /[\ud800-\udbff][\udc00-\udfff]|[\s\S]/y;
    }
    const isExtender = cp =>
        cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
        (cp >= 0xe0020 && cp <= 0xe007f) || (cp >= 0x300 && cp <= 0x36f) || /\p{M}/u.test(String.fromCodePoint(cp));
    const isRegional = cp => cp >= 0x1f1e6 && cp <= 0x1f1ff;
    const isCJK = ch => /[぀-ヿ㐀-鿿豈-﫿＀-￯　-〿]/.test(ch);
    const NO_LINE_START = /^[、。，．・：；？！ー」』）】〉》…―\-,.!?;:)\]"'’”～]/;

    //-------------------------------------------------------------------------
    // Private measurement bitmap (real game font, cached only once fonts are ready)
    //-------------------------------------------------------------------------
    const Measure = {
        bmp: null,
        cache: new Map(),
        width(text, size, face, bold, italic) {
            if (!this.bmp) this.bmp = new Bitmap(16, 16);
            const key = size + "|" + face + "|" + (bold ? 1 : 0) + (italic ? 1 : 0) + "|" + text;
            const hit = this.cache.get(key);
            if (hit !== undefined) return hit;
            const b = this.bmp;
            b.fontFace = face;
            b.fontSize = size;
            b.fontBold = !!bold;
            b.fontItalic = !!italic;
            const w = b.measureTextWidth(text);
            if (this.fontsReady(size, face)) {
                if (this.cache.size > 20000) this.cache.clear();
                this.cache.set(key, w);
            }
            return w;
        },
        fontsReady(size, face) {
            try {
                return FontManager.isReady() && document.fonts.check(size + "px " + face.split(",")[0].trim());
            } catch (e) {
                return false;
            }
        }
    };

    //-------------------------------------------------------------------------
    // Tokenizer of CONVERTED text (\x1b codes), consuming params like the engine
    //-------------------------------------------------------------------------
    const NUM_PARAM = new Set(["C", "I", "PX", "PY", "FS"]);
    const STR_PARAM = new Set();
    function tokenize(text, numParam = NUM_PARAM, strParam = STR_PARAM) {
        const toks = [];
        let i = 0;
        let guard = 0;
        while (i < text.length && guard++ < 100000) {
            const c = text[i];
            if (c === "\x1b") {
                const m = /^[$.|^!><{}\\]|^[A-Z]+/i.exec(text.slice(i + 1));
                if (!m) {
                    toks.push({ t: "esc", code: "", s: i, e: i + 1 });
                    i++;
                    continue;
                }
                const code = m[0].toUpperCase();
                let end = i + 1 + m[0].length;
                let param = null;
                if (numParam.has(code)) {
                    const p = /^\[\d+\]/.exec(text.slice(end));
                    if (p) { param = parseInt(p[0].slice(1)); end += p[0].length; }
                } else if (strParam.has(code)) {
                    const p = /^\[.+?]/.exec(text.slice(end));
                    if (p) { param = p[0].slice(1, -1); end += p[0].length; }
                }
                toks.push({ t: "esc", code, param, s: i, e: end });
                i = end;
                continue;
            }
            if (c === "\n") { toks.push({ t: "nl", s: i, e: i + 1 }); i++; continue; }
            if (c.charCodeAt(0) < 0x20) { toks.push({ t: "ctl", s: i, e: i + 1 }); i++; continue; }
            GRAPHEME.lastIndex = i;
            const g = (GRAPHEME.exec(text) || [c])[0];
            toks.push({ t: "ch", g, s: i, e: i + g.length, space: /^\s$/.test(g) });
            i += g.length;
        }
        return toks;
    }

    // Font size before each token (tracks \{ \} \FS like makeFontBigger/Smaller)
    function sizesBefore(toks, size0) {
        const out = new Array(toks.length + 1);
        let s = size0;
        for (let k = 0; k < toks.length; k++) {
            out[k] = s;
            const t = toks[k];
            if (t.t === "esc") {
                if (t.code === "{" && s <= 96) s += 12;
                else if (t.code === "}" && s >= 24) s -= 12;
                else if (t.code === "FS" && t.param !== null) s = t.param;
            }
        }
        out[toks.length] = s;
        return out;
    }

    // Width of toks[a..b): progressive drawing = sum of graphemes; instant drawing = whole runs.
    // Returns the max of both (no kerning loss either way).
    function rangeWidth(toks, sizes, a, b, f) {
        let total = 0, run = "", runSum = 0, runSize = null;
        const flush = () => {
            if (run) total += Math.max(runSum, Measure.width(run, runSize, f.face, f.bold, f.italic));
            run = ""; runSum = 0;
        };
        for (let k = a; k < b; k++) {
            const t = toks[k];
            if (t.t === "ch") {
                const s = sizes[k];
                if (runSize !== s) { flush(); runSize = s; }
                run += t.g;
                runSum += Measure.width(t.g, s, f.face, f.bold, f.italic);
            } else {
                flush();
                if (t.t === "esc" && t.code === "I") total += f.iconWidth + 4;
            }
        }
        flush();
        return total;
    }

    const visibleTok = t => (t.t === "ch" && !t.space) || (t.t === "esc" && t.code === "I");

    //-------------------------------------------------------------------------
    // Reflow: join explicit breaks that look like the tool's greedy wrap
    //-------------------------------------------------------------------------
    const plainOf = s => s.replace(/\x1b([$.|^!><{}\\]|[A-Z]+)(\[\d+\])?/gi, "");
    function reflowText(text, cols) {
        const segs = text.split("\n");
        if (segs.length < 2) return text;
        let out = segs[0];
        for (let k = 1; k < segs.length; k++) {
            const prev = plainOf(segs[k - 1]).trim();
            const next = plainOf(segs[k]).trim();
            const firstWord = next.split(/\s+/)[0] || "";
            const soft = prev && next && [...prev].length <= cols && [...prev].length + 1 + [...firstWord].length > cols;
            out += (soft ? " " : "\n") + segs[k];
        }
        return out;
    }

    //-------------------------------------------------------------------------
    // Greedy wrap of converted text. Returns {text, autoBreaks:Set of "\n" indices} or null (absolute positioning).
    //-------------------------------------------------------------------------
    function wrapText(text, maxW, f) {
        const toks = tokenize(text, f.numParam, f.strParam);
        if (toks.some(t => t.t === "esc" && (t.code === "PX" || t.code === "PY"))) return null;
        if (maxW < f.size * 2) return null; // a zone of a few characters is a zone error: never break letter by letter
        const sizes = sizesBefore(toks, f.size);
        const action = new Array(toks.length).fill(null); // "nl" (replace space), "drop", "after", "before"
        let lineStart = 0;
        let iter = 0;
        let k = 0;
        while (k < toks.length && iter++ < MAX_ITER * 10) {
            const t = toks[k];
            if (t.t === "nl" || action[k] === "nl") { lineStart = k + 1; k++; continue; }
            if (!visibleTok(t)) { k++; continue; }
            const w = rangeWidth(toks, sizes, lineStart, k + 1, f);
            if (w <= maxW) { k++; continue; }
            // find the last break opportunity on this line before k
            let firstVis = lineStart;
            while (firstVis < k && !visibleTok(toks[firstVis])) firstVis++;
            let brk = -1, kind = null;
            for (let j = k; j > firstVis; j--) {
                const a = toks[j - 1], b = toks[j];
                if (b.t === "ch" && b.space && j < k) { brk = j; kind = "space"; break; }
                if (a.t === "ch" && !a.space && b.t === "ch" && !b.space) {
                    const prevCh = a.g, nextCh = b.g;
                    const wordy = /[\p{L}\p{N}]/u.test(nextCh);
                    if ((/^[-‐]$/.test(prevCh) && /[\p{L}]/u.test(toks[j - 2] ? toks[j - 2].g || "" : "") && wordy) ||
                        (/^[…―—]$/.test(prevCh) && wordy) ||
                        ((isCJK(prevCh) || isCJK(nextCh)) && !NO_LINE_START.test(nextCh))) {
                        brk = j; kind = "before";
                        break;
                    }
                }
            }
            if (brk < 0) {
                // over-long word: break between graphemes, before k
                if (k > firstVis) { action[k] = "before"; lineStart = k; }
                k++;
                continue;
            }
            if (kind === "space") {
                action[brk] = "nl";
                let s = brk + 1;
                while (s < toks.length && toks[s].t === "ch" && toks[s].space) action[s++] = "drop";
                // spaces just before the break are dropped too (no trailing blanks)
                let p = brk - 1;
                while (p > lineStart && toks[p].t === "ch" && toks[p].space) action[p--] = "drop";
                lineStart = brk + 1;
            } else {
                action[brk] = "before";
                lineStart = brk;
            }
            // re-check from the new line start without advancing k
        }
        let out = "";
        const auto = new Set();
        for (let j = 0; j < toks.length; j++) {
            const t = toks[j];
            const raw = text.slice(t.s, t.e);
            const a = action[j];
            if (a === "nl") { auto.add(out.length); out += "\n"; }
            else if (a === "drop") { /* removed */ }
            else if (a === "before") { auto.add(out.length); out += "\n" + raw; }
            else out += raw;
        }
        return { text: out, autoBreaks: auto };
    }

    function fontOf(win, size) {
        const c = win.contents;
        return {
            size: size || c.fontSize,
            face: c.fontFace || $gameSystem.mainFontFace(),
            bold: c.fontBold, italic: c.fontItalic,
            iconWidth: ImageManager.standardIconWidth || ImageManager.iconWidth,
            numParam: NUM_PARAM, strParam: STR_PARAM
        };
    }

    // Is anything visible left from index? (no blank page for trailing spaces / invisible codes)
    function hasVisibleRest(text, index) {
        const toks = tokenize(text.slice(index));
        return toks.some(visibleTok);
    }

    //-------------------------------------------------------------------------
    // Window_Message
    //-------------------------------------------------------------------------
    const visibleHeight = win => Math.min(win.contents.height, win.innerHeight);
    const visibleWidth = win => Math.min(win.contents.width, win.innerWidth);

    const _WM_startMessage = Window_Message.prototype.startMessage;
    Window_Message.prototype.startMessage = function() {
        _WM_startMessage.apply(this, arguments);
        const ts = this._textState;
        if (!CFG.messageWrap || !ts || ts.rtl) return;
        try {
            let text = ts.text;
            if (CFG.reflow) text = reflowText(text, CFG.toolCols);
            const maxW = visibleWidth(this) - ts.startX - CFG.messageRightMargin;
            const res = wrapText(text, maxW, fontOf(this));
            if (!res) return;
            ts.text = res.text;
            ts._autoBreaks = res.autoBreaks;
            ts.height = this.calcTextHeight(ts);
        } catch (e) {
            console.error(PLUGIN, e);
        }
    };

    const _WM_processNewLine = Window_Message.prototype.processNewLine;
    Window_Message.prototype.processNewLine = function(textState) {
        const auto = textState._autoBreaks && textState._autoBreaks.has(textState.index - 1);
        const fast = this._lineShowFast;
        _WM_processNewLine.apply(this, arguments);
        if (auto) this._lineShowFast = fast;
    };

    const _WM_needsNewPage = Window_Message.prototype.needsNewPage;
    Window_Message.prototype.needsNewPage = function(textState) {
        if (!CFG.messageWrap) return _WM_needsNewPage.apply(this, arguments);
        if (this.isEndOfText(textState)) return false;
        if (textState.y + textState.height <= visibleHeight(this)) return false;
        return hasVisibleRest(textState.text, textState.index);
    };

    const _WM_newPage = Window_Message.prototype.newPage;
    Window_Message.prototype.newPage = function(textState) {
        const carry = CFG.carryStyle && textState && textState.index > 0 && this.contents;
        let st = null;
        if (carry) {
            const c = this.contents;
            st = {
                textColor: c.textColor, outlineColor: c.outlineColor, outlineWidth: c.outlineWidth,
                fontSize: c.fontSize, fontBold: c.fontBold, fontItalic: c.fontItalic, fontFace: c.fontFace,
                lineShowFast: this._lineShowFast, pauseSkip: this._pauseSkip
            };
        }
        _WM_newPage.apply(this, arguments);
        if (st) {
            const c = this.contents;
            c.textColor = st.textColor; c.outlineColor = st.outlineColor; c.outlineWidth = st.outlineWidth;
            c.fontSize = st.fontSize; c.fontBold = st.fontBold; c.fontItalic = st.fontItalic; c.fontFace = st.fontFace;
            this._lineShowFast = st.lineShowFast;
            this._pauseSkip = st.pauseSkip;
            textState.height = this.calcTextHeight(textState);
        }
    };

    // Keep every grapheme (combining marks, ZWJ, variation selectors, modifiers, flags) in one draw call
    const _WM_canBreakHere = Window_Message.prototype.canBreakHere;
    Window_Message.prototype.canBreakHere = function(textState) {
        if (!_WM_canBreakHere.apply(this, arguments)) return false;
        if (this.isEndOfText(textState)) return true;
        const text = textState.text;
        const i = textState.index;
        const next = text.codePointAt(i);
        if (next !== undefined && next >= 0x20 && isExtender(next)) return false;
        if (i > 0) {
            const prevUnit = text.charCodeAt(i - 1);
            const prev = prevUnit >= 0xdc00 && prevUnit <= 0xdfff && i > 1 ? text.codePointAt(i - 2) : prevUnit;
            if (prev === 0x200d) return false;
            if (isRegional(prev) && isRegional(next)) {
                // odd number of regional indicators before -> inside a flag
                let n = 0, j = i;
                while (j > 1 && isRegional(text.codePointAt(j - 2))) { n++; j -= 2; }
                if (n % 2 === 1) return false;
            }
        }
        return true;
    };

    //-------------------------------------------------------------------------
    // Window_ScrollText
    //-------------------------------------------------------------------------
    Window_ScrollText.prototype.convertEscapeCharacters = function(text) {
        text = Window_Base.prototype.convertEscapeCharacters.call(this, text);
        if (!CFG.scrollTextWrap) return text;
        try {
            const rect = this.baseTextRect();
            if (CFG.reflow) text = reflowText(text, CFG.toolCols);
            const maxW = rect.width - Math.max(0, CFG.scrollRightMargin - rect.x);
            this.resetFontSettings();
            const res = wrapText(text, maxW, fontOf(this));
            return res ? res.text : text;
        } catch (e) {
            console.error(PLUGIN, e);
            return text;
        }
    };

    //-------------------------------------------------------------------------
    // Single-line fitting helpers
    //-------------------------------------------------------------------------
    const minSize = base => Math.max(1, Math.ceil(base * CFG.minFontRatio));
    const hasEscape = s => /[\x1b\\]/.test(s);

    // Largest size whose natural width / maxWidth <= limit
    function fitSize(text, maxWidth, base, f, limit) {
        let s = base;
        let it = 0;
        while (s > minSize(base) && it++ < MAX_ITER) {
            if (Measure.width(text, s, f.face, f.bold, f.italic) <= maxWidth * limit) break;
            s--;
        }
        return s;
    }

    // Window_Base.drawText (labels, commands, option names...)
    const _WB_drawText = Window_Base.prototype.drawText;
    Window_Base.prototype.drawText = function(text, x, y, maxWidth, align) {
        if (CFG.labelFit && maxWidth > 0 && this.contents && text !== undefined && text !== null) {
            const s = String(text);
            const c = this.contents;
            const w = this.textWidth(s);
            if (w > maxWidth * CFG.maxCompression) {
                const base = c.fontSize;
                const size = fitSize(s, maxWidth, base, fontOf(this), CFG.maxCompression);
                c.fontSize = size;
                _WB_drawText.call(this, s, x, y, maxWidth, align);
                c.fontSize = base;
                return;
            }
        }
        return _WB_drawText.apply(this, arguments);
    };

    // Choices: drawTextEx never compresses -> fit inside the item rect
    const _WCL_drawItem = Window_ChoiceList.prototype.drawItem;
    Window_ChoiceList.prototype.drawItem = function(index) {
        if (!CFG.choiceFit) return _WCL_drawItem.apply(this, arguments);
        const rect = this.itemLineRect(index);
        const raw = this.commandName(index);
        this.resetFontSettings();
        const f = fontOf(this);
        if (!hasEscape(raw)) {
            const w = Measure.width(raw, f.size, f.face, f.bold, f.italic);
            if (w <= rect.width) return _WCL_drawItem.apply(this, arguments);
            this.contents.fontSize = fitSize(raw, rect.width, f.size, f, CFG.maxCompression);
            _WB_drawText.call(this, raw, rect.x, rect.y, rect.width, "left");
            this.resetFontSettings();
            return;
        }
        // with escape codes: measure the converted text with the tokenizer (no code executed)
        const conv = Window_Base.prototype.convertEscapeCharacters.call(this, raw);
        const toks = tokenize(conv);
        const width = size => rangeWidth(toks, sizesBefore(toks, size), 0, toks.length, Object.assign({}, f, { size }));
        if (width(f.size) <= rect.width) return _WCL_drawItem.apply(this, arguments);
        let s = f.size, it = 0;
        while (s > minSize(f.size) && width(s) > rect.width && it++ < MAX_ITER) s--;
        this.drawTextEx("\\FS[" + s + "]" + raw, rect.x, rect.y, rect.width);
    };

    //-------------------------------------------------------------------------
    // DTextPicture (status screen): keep each text picture on screen, inside its own height
    //-------------------------------------------------------------------------
    const DT_NUM = new Set(["C", "I", "PX", "PY", "FS", "OW"]);
    const DT_STR = new Set(["OC", "F"]);
    let compressPlan = null; // {factors: Map(lineIndex -> factor)} while a text picture is being built

    function dtextLines(text, base, f) {
        const toks = tokenize(text, DT_NUM, DT_STR);
        const sizes = sizesBefore(toks, base);
        const lines = [];
        let a = 0;
        for (let k = 0; k <= toks.length; k++) {
            if (k === toks.length || toks[k].t === "nl") {
                lines.push(rangeWidth(toks, sizes, a, k, Object.assign({}, f, { size: base })));
                a = k + 1;
            }
        }
        return lines;
    }

    function computeDTextFit(pic, info) {
        if (!CFG.dtextFit || !info || info.vertical || info.pictureWidth || pic.origin() !== 0) return null;
        const text = pic.getDText();
        if (!text) return null;
        const scale = pic.scaleX() / 100;
        if (scale <= 0) return null;
        const availW = (Graphics.width - pic.x() - CFG.dtextRightMargin) / scale;
        const base = info.size > 0 ? Number(info.size) : $gameSystem.mainFontSize();
        const f = { face: info.font || $gameSystem.mainFontFace(), bold: false, italic: false,
            iconWidth: ImageManager.standardIconWidth || ImageManager.iconWidth, numParam: DT_NUM, strParam: DT_STR };
        const widths = dtextLines(text, base, Object.assign({}, f, { size: base }));
        if (Math.max(...widths) <= availW) return null;
        const spacing = Window_Base.prototype.lineHeight.call(null) - $gameSystem.mainFontSize();
        const baseLH = info.lineHeight > 0 ? Number(info.lineHeight) : base + spacing;
        const origLines = text.split("\n").length;
        const setSize = (t, s) => (/^\x1bFS\[\d+\]/i.test(t) ? t.replace(/^\x1bFS\[\d+\]/i, "\x1bFS[" + s + "]") : "\x1bFS[" + s + "]" + t);
        if (CFG.dtextMode === "line" || CFG.dtextMode === "compress") {
            const lines = text.split("\n");
            const factors = new Map();
            for (let k = 0; k < lines.length; k++) {
                if (widths[k] <= availW) continue;
                if (CFG.dtextMode === "compress" && widths[k] / availW <= CFG.maxCompression) {
                    factors.set(k, widths[k] / availW);
                    continue;
                }
                let s = base, it = 0;
                while (s > minSize(base) && it++ < MAX_ITER) {
                    if (dtextLines(setSize(lines[k], s), s, Object.assign({}, f, { size: s }))[0] <= availW) break;
                    s--;
                }
                lines[k] = setSize(lines[k], s) + "\x1bFS[" + base + "]";
            }
            return { text: lines.join("\n"), size: info.size, lineHeight: baseLH, factors };
        }
        // block: wrap, then shrink the whole block until it fits within its original height
        for (let s = base, it = 0; s >= minSize(base) && it < MAX_ITER; s--, it++) {
            const ff = Object.assign({}, f, { size: s });
            const res = wrapText(setSize(text, s), availW, ff);
            if (!res) return null;
            const lh = Math.round((baseLH * s) / base);
            const n = res.text.split("\n").length;
            if (n * lh <= origLines * baseLH && Math.max(...dtextLines(res.text, s, ff)) <= availW) {
                return { text: res.text, size: s, lineHeight: lh, factors: null };
            }
        }
        return null; // cannot fit at a readable size: leave as is
    }

    if (Sprite_Picture.prototype.makeDynamicBitmap) {
        const _SP_makeDynamicBitmap = Sprite_Picture.prototype.makeDynamicBitmap;
        Sprite_Picture.prototype.makeDynamicBitmap = function() {
            const pic = this.picture();
            const info = this.dTextInfo;
            let fit = null;
            try { fit = computeDTextFit(pic, info); } catch (e) { console.error(PLUGIN, e); }
            if (!fit) return _SP_makeDynamicBitmap.apply(this, arguments);
            const saved = { size: info.size, lineHeight: info.lineHeight };
            pic.getDText = () => fit.text;
            info.size = fit.size;
            info.lineHeight = fit.lineHeight;
            compressPlan = fit.factors && fit.factors.size ? fit.factors : null;
            try {
                return _SP_makeDynamicBitmap.apply(this, arguments);
            } finally {
                delete pic.getDText;
                info.size = saved.size;
                info.lineHeight = saved.lineHeight;
                compressPlan = null;
            }
        };

        // compress mode: squeeze the runs of the planned lines (only while a text picture is being built)
        const _WB_flushTextState = Window_Base.prototype.flushTextState;
        Window_Base.prototype.flushTextState = function(textState) {
            if (!compressPlan) return _WB_flushTextState.apply(this, arguments);
            const lineIndex = (textState.text.slice(0, textState.index).match(/\n/g) || []).length -
                (textState.text[textState.index - 1] === "\n" ? 1 : 0);
            const factor = compressPlan.get(lineIndex);
            if (!factor || !textState.buffer) return _WB_flushTextState.apply(this, arguments);
            const text = textState.buffer;
            const width = this.textWidth(text) / factor;
            if (textState.drawing) this.contents.drawText(text, textState.x, textState.y, width, textState.height);
            textState.x += width;
            textState.buffer = this.createTextBuffer(textState.rtl);
            const outputWidth = Math.abs(textState.x - textState.startX);
            if (textState.outputWidth < outputWidth) textState.outputWidth = outputWidth;
            textState.outputHeight = textState.y - textState.startY + textState.height;
        };
    }

    // exposed for the test harness only
    window.TextFit_Oukyu = { CFG, wrapText, reflowText, tokenize, Measure };
})();
