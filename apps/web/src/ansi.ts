/**
 * Minimal ANSI SGR (Select Graphic Rendition) parser. Converts a string with
 * escape codes into styled segments for rendering as <span>s. Unsupported
 * sequences (cursor moves, OSC, etc.) are stripped rather than displayed.
 */

import type { CSSProperties } from "react";

export interface AnsiSegment {
    text: string;
    style: AnsiStyle;
}

export interface AnsiStyle {
    color?: string;
    bgColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
}

// Standard 16-color palette (foreground codes 30-37 / 90-97).
const FG: Record<number, string> = {
    30: "#3b4048", 31: "#e06c75", 32: "#98c379", 33: "#d19a66",
    34: "#61afef", 35: "#c678dd", 36: "#56b6c2", 37: "#abb2bf",
    90: "#5c6370", 91: "#e06c75", 92: "#98c379", 93: "#e5c07b",
    94: "#61afef", 95: "#c678dd", 96: "#56b6c2", 97: "#ffffff",
};
const BG: Record<number, string> = {
    40: "#3b4048", 41: "#e06c75", 42: "#98c379", 43: "#d19a66",
    44: "#61afef", 45: "#c678dd", 46: "#56b6c2", 47: "#abb2bf",
    100: "#5c6370", 101: "#e06c75", 102: "#98c379", 103: "#e5c07b",
    104: "#61afef", 105: "#c678dd", 106: "#56b6c2", 107: "#ffffff",
};

// CSI sequence: ESC [ <params> <final-byte>. We only act on SGR ("m").
const CSI_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;
// Other escape sequences we strip without acting on (OSC, single-char escapes).
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LONE_ESC_RE = /\x1b[@-Z\\-_]/g;

function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
    let next = { ...style };
    // An empty parameter list means reset.
    const codes = params.length === 0 ? [0] : params;
    for (const code of codes) {
        if (code === 0) {
            next = {};
        } else if (code === 1) {
            next.bold = true;
        } else if (code === 2) {
            next.dim = true;
        } else if (code === 3) {
            next.italic = true;
        } else if (code === 4) {
            next.underline = true;
        } else if (code === 22) {
            next.bold = false;
            next.dim = false;
        } else if (code === 23) {
            next.italic = false;
        } else if (code === 24) {
            next.underline = false;
        } else if (code === 39) {
            next.color = undefined;
        } else if (code === 49) {
            next.bgColor = undefined;
        } else if (FG[code]) {
            next.color = FG[code];
        } else if (BG[code]) {
            next.bgColor = BG[code];
        }
    }
    return next;
}

export function ansiToSegments(input: string): AnsiSegment[] {
    // Drop OSC and lone escapes up front; they don't affect styling.
    const text = input.replace(OSC_RE, "").replace(LONE_ESC_RE, "");

    const segments: AnsiSegment[] = [];
    let style: AnsiStyle = {};
    let lastIndex = 0;
    CSI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CSI_RE.exec(text)) !== null) {
        if (m.index > lastIndex) {
            segments.push({ text: text.slice(lastIndex, m.index), style });
        }
        if (m[2] === "m") {
            const params = m[1] ? m[1].split(";").map((p) => Number(p) || 0) : [];
            style = applySgr(style, params);
        }
        // Non-SGR CSI sequences are simply dropped.
        lastIndex = CSI_RE.lastIndex;
    }
    if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), style });
    }
    return segments;
}

export function ansiStyleToCss(style: AnsiStyle): CSSProperties {
    return {
        color: style.color,
        backgroundColor: style.bgColor,
        fontWeight: style.bold ? 600 : undefined,
        fontStyle: style.italic ? "italic" : undefined,
        textDecoration: style.underline ? "underline" : undefined,
        opacity: style.dim ? 0.6 : undefined,
    };
}
