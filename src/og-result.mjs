// Shareable result card, rendered by Satori on the edge (see src/og-worker.js).
// Pure element tree: no runtime imports, so it can be rendered in a local smoke test too.
// Sizes: 1200×630 (link preview) and 1080×1920 (WhatsApp Status / Instagram Stories).
const INDIGO = "#1b2470", DEEP = "#111853", MARIGOLD = "#f6b52b", SOFT = "#c7cdf1", WHITE = "#ffffff";

const box = (style, children) => ({ type: "div", props: { style, children } });
const text = (style, value) => ({ type: "div", props: { style, children: value } });

export function resultCard(m) {
  const story = !!m.story;
  const W = story ? 1080 : 1200, H = story ? 1920 : 630;
  const pad = story ? 84 : 64;
  const scale = story ? 1.55 : 1;
  const s = (n) => Math.round(n * scale);
  return box(
    {
      width: W, height: H, display: "flex", flexDirection: "column", justifyContent: "space-between",
      background: `linear-gradient(160deg, ${DEEP} 0%, ${INDIGO} 62%, #24308f 100%)`,
      padding: pad, fontFamily: "Figtree", color: WHITE, boxSizing: "border-box"
    },
    [
      // Brand row
      box({ display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        box({ display: "flex", alignItems: "baseline", fontSize: s(34), fontWeight: 700, letterSpacing: "-0.5px" }, [
          text({}, "sendfair"),
          text({ color: MARIGOLD }, ".")
        ]),
        text({ fontSize: s(22), fontWeight: 700, letterSpacing: "2px", color: MARIGOLD }, "MONEY HOME, PRICED HONESTLY")
      ]),
      // Headline block
      box({ display: "flex", flexDirection: "column", justifyContent: "center", flex: 1, paddingTop: s(24) }, [
        text({ fontSize: s(52), fontWeight: 400, color: SOFT, lineHeight: 1.12 }, `Sending ${m.amountLabel} to ${m.country}?`),
        box({ display: "flex", alignItems: "baseline", marginTop: s(18) }, [
          text({ fontSize: s(104), fontWeight: 700, color: MARIGOLD, lineHeight: 1.02, letterSpacing: "-2px" }, m.bestGets)
        ]),
        text({ fontSize: s(44), fontWeight: 500, color: WHITE, marginTop: s(6) }, `with ${m.bestName}`),
        box({ display: "flex", alignItems: "center", marginTop: s(22), background: "rgba(246,181,43,0.14)", border: `2px solid rgba(246,181,43,0.5)`, borderRadius: 999, padding: `${s(12)}px ${s(26)}px`, alignSelf: "flex-start" }, [
          text({ fontSize: s(30), fontWeight: 600, color: MARIGOLD }, m.delta)
        ])
      ]),
      // Footer
      box({ display: "flex", alignItems: "flex-end", justifyContent: "space-between", borderTop: "1px solid rgba(199,205,241,0.35)", paddingTop: s(22) }, [
        box({ display: "flex", flexDirection: "column" }, [
          text({ fontSize: s(22), color: SOFT }, `Checked ${m.date}`),
          text({ fontSize: s(20), color: SOFT, marginTop: s(6) }, "Rates change through the day; confirm on the provider's screen.")
        ]),
        text({ fontSize: s(24), fontWeight: 700, color: WHITE }, "sendfair.africa")
      ])
    ]
  );
}
