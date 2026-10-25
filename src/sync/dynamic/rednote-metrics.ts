/** Read only; exact work ID and explicitly labelled counters are required. */
export async function collectRednoteMetrics(noteId: string) {
  const base = { url: location.href, noteId, collectedAt: new Date().toISOString() };
  if (location.origin !== "https://creator.xiaohongshu.com" || location.pathname !== "/new/note-manager")
    return { status: "needs_attention", code: "METRICS_PAGE_REQUIRED", evidence: base };
  // These fields were verified against the creator site's own read-only manager response.
  try {
    for (let page = 0; page < 10; page += 1) {
      const response = await fetch(`/api/galaxy/v2/creator/note/user/posted?tab=0&page=${page}`, {
        credentials: "include",
      });
      if (!response.ok) break;
      const data = await response.json();
      if (data?.code !== 0 || data?.success !== true || !Array.isArray(data?.data?.notes)) break;
      const matches = data.data.notes.filter((note: { id?: string }) => note.id === noteId);
      if (matches.length === 1) {
        const note = matches[0];
        const count = (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
        return {
          status: "metrics_collected",
          code: "METRICS_READ_ONLY",
          evidence: {
            ...base,
            source: "creator_api",
            metrics: {
              曝光: null,
              阅读: null,
              观看: count(note.view_count),
              点赞: count(note.likes),
              收藏: count(note.collected_count),
              评论: count(note.comments_count),
              分享: count(note.shared_count),
            },
            missingReason: "view_count is recorded as 观看; unavailable metrics stay null.",
          },
        };
      }
      if (data.data.page === -1 || data.data.notes.length === 0) break;
    }
  } catch {
    // Only explicitly labelled counters may be used as the DOM fallback.
  }
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".note-card")).filter((card) => {
    try {
      return JSON.parse(card.getAttribute("data-impression") || "null")?.noteTarget?.value?.noteId === noteId;
    } catch {
      return false;
    }
  });
  if (cards.length !== 1)
    return {
      status: "needs_attention",
      code: "METRICS_WORK_NOT_FOUND",
      evidence: { ...base, matchedCards: cards.length },
    };
  // Verified against the current manager DOM and its own response for the same work ID.
  // Require every icon signature before applying the positional schema; changed markup stays unknown.
  const stats = Array.from(cards[0].querySelectorAll<HTMLElement>(".note-card__stat"));
  const icons = ["M7.99902 3.83398", "M3.18233 10.985", "M3.25611 3.91336", "M10.8848 14.2322", "M8.28672 5.15797"];
  if (
    stats.length === 5 &&
    stats.every((stat, index) => stat.querySelector("svg path")?.getAttribute("d")?.startsWith(icons[index]))
  ) {
    const integer = (stat: HTMLElement) => {
      const value = stat.querySelector("span")?.textContent?.trim() || "";
      const number = /^\d[\d,]*$/.test(value) ? Number(value.replace(/,/g, "")) : Number.NaN;
      return Number.isSafeInteger(number) && number >= 0 ? number : null;
    };
    const values = stats.map(integer);
    return {
      status: "metrics_collected",
      code: "METRICS_READ_ONLY",
      evidence: {
        ...base,
        source: "creator_dom_verified_icons",
        metrics: {
          曝光: null,
          阅读: null,
          观看: values[0],
          评论: values[1],
          点赞: values[2],
          收藏: values[3],
          分享: values[4],
        },
        missingReason:
          "Five icon signatures and the exact work ID matched the verified manager schema; view count is 观看.",
      },
    };
  }
  const metrics: Record<string, number | null> = {};
  const text = cards[0].innerText;
  for (const label of ["曝光", "阅读", "观看", "点赞", "收藏", "评论", "分享"]) {
    // Abbreviations such as 1.2万 are intentionally left unknown instead of guessed.
    const match =
      text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]?\\s*(\\d[\\d,]*)\\s*(?:$|\\n)`)) ||
      text.match(new RegExp(`(?:^|\\n)\\s*(\\d[\\d,]*)\\s*${label}\\s*(?:$|\\n)`));
    metrics[label] = match ? Number(match[1].replace(/,/g, "")) : null;
  }
  return {
    status: "metrics_collected",
    code: "METRICS_READ_ONLY",
    evidence: {
      ...base,
      metrics,
      missingReason: "Only explicitly labelled integer counters on the matched work are collected.",
    },
  };
}
