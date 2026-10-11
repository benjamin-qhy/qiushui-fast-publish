import type { DynamicData } from "../common";

export interface PreparedPublishResult {
  status: "clicked" | "needs_attention" | "result_unconfirmed" | "published" | "submitted_pending_review";
  code: string;
  evidence: Record<string, unknown>;
}

export function verifyDouyinProfile(data: DynamicData): PreparedPublishResult {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/note/"]'));
  const matching = links.filter(
    (link) =>
      normalize(link.innerText).includes(normalize(data.title)) &&
      normalize(link.innerText).includes(normalize(data.content).slice(0, 24)),
  );
  const href = matching.length === 1 ? matching[0].href : "";
  return location.origin === "https://www.douyin.com" && /^https:\/\/www\.douyin\.com\/note\/\d+$/.test(href)
    ? {
        status: "published",
        code: "WORK_LINK_CONFIRMED",
        evidence: { workUrl: href, matchedLinks: matching.length, profileUrl: location.href },
      }
    : {
        status: "result_unconfirmed",
        code: "PUBLISH_RESULT_NOT_CONFIRMED",
        evidence: { profileUrl: location.href, matchedLinks: matching.length },
      };
}

// This function runs in the existing prepared tab. It never uploads or fills again.
export async function publishPreparedDynamic(
  platform: string,
  data: DynamicData,
  mode: "click" | "verify",
  preparedEvidence: Record<string, unknown> = {},
): Promise<PreparedPublishResult> {
  const expectedOrigins: Record<string, string> = {
    DYNAMIC_REDNOTE: "https://creator.xiaohongshu.com",
    DYNAMIC_WEIXINCHANNEL: "https://channels.weixin.qq.com",
    DYNAMIC_DOUYIN: "https://creator.douyin.com",
    DYNAMIC_TOUTIAO: "https://mp.toutiao.com",
    DYNAMIC_OKJIKE: "https://web.okjike.com",
    DYNAMIC_ZSXQ: "https://wx.zsxq.com",
    DYNAMIC_MAIMAI: "https://maimai.cn",
    DYNAMIC_X: "https://x.com",
    DYNAMIC_WEIXIN: "https://mp.weixin.qq.com",
  };
  const visible = (element: Element) => Boolean(element.getClientRects().length);
  const deep = (root: Document | ShadowRoot, selector: string): Element[] => {
    const found = Array.from(root.querySelectorAll(selector));
    for (const node of Array.from(root.querySelectorAll("*"))) {
      if (node.shadowRoot) found.push(...deep(node.shadowRoot, selector));
    }
    return found;
  };
  const normalize = (value: string) =>
    value
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const currentUrl = location.href;
  const allText = document.body.innerText;
  const pageText = `${allText.slice(0, 550)}\n…\n${allText.slice(-1050)}`;
  const links = deep(document, "a[href]")
    .filter(visible)
    .map((node) => ({ text: (node.textContent || "").trim().slice(0, 80), href: (node as HTMLAnchorElement).href }))
    .filter((link) =>
      /status\/\d+|explore\/[\da-f]+|discovery\/item\/[\da-f]+|topic_detail|\/w\/\d+|\/note\/\d+/.test(link.href),
    )
    .slice(0, 12);
  const evidence: Record<string, unknown> = { url: currentUrl, pageText: pageText.slice(-900), links };
  if (location.origin !== expectedOrigins[platform])
    return { status: "needs_attention", code: "PLATFORM_ORIGIN_CHANGED", evidence };

  if (mode === "verify") {
    if (platform === "DYNAMIC_WEIXINCHANNEL") {
      // The editor's "发表" click is not a publication receipt. Keep the
      // result unknown until a site-specific work identifier is observed.
      const review = /审核中|等待审核|提交审核|审核处理中/.test(allText);
      const editorOpen = deep(document, 'div[data-placeholder*="添加描述"], div.input-editor').some(visible);
      const matchingContent =
        normalize(allText).includes(normalize(data.title)) &&
        normalize(allText).includes(normalize(data.content).slice(0, 24));
      return review && !editorOpen && matchingContent
        ? { status: "submitted_pending_review", code: "PLATFORM_REVIEW_PENDING", evidence }
        : { status: "result_unconfirmed", code: "PUBLISH_RESULT_NOT_CONFIRMED", evidence };
    }
    if (platform === "DYNAMIC_OKJIKE" && /^\/u\/[^/]+\/post\/[a-f\d]{24}$/i.test(location.pathname)) {
      const exactText =
        normalize(allText).includes(normalize(data.title)) &&
        normalize(allText).includes(normalize(data.content).slice(0, 24));
      const images = document.querySelectorAll('img[alt="图片"]').length;
      return exactText && images === data.images.length
        ? {
            status: "published",
            code: "WORK_LINK_CONFIRMED",
            evidence: { ...evidence, workUrl: currentUrl, imageCount: images },
          }
        : {
            status: "result_unconfirmed",
            code: "PUBLISH_RESULT_NOT_CONFIRMED",
            evidence: { ...evidence, imageCount: images },
          };
    }
    if (platform === "DYNAMIC_MAIMAI" && /^\/community\/gossip-detail\/\d+$/.test(location.pathname)) {
      const titleNode = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
        (node) => node.innerText.trim() === data.title,
      );
      const card = titleNode?.closest<HTMLElement>(".bg-background.px-6.mb-6");
      const exactText = Boolean(card && normalize(card.innerText).includes(normalize(data.content).slice(0, 24)));
      const images = card
        ? Array.from(card.querySelectorAll<HTMLImageElement>("img")).filter(
            (img) => img.naturalWidth === 160 && img.naturalHeight === 160,
          ).length
        : 0;
      return exactText && images === data.images.length
        ? {
            status: "published",
            code: "WORK_LINK_CONFIRMED",
            evidence: { ...evidence, workUrl: currentUrl, imageCount: images },
          }
        : {
            status: "result_unconfirmed",
            code: "PUBLISH_RESULT_NOT_CONFIRMED",
            evidence: { ...evidence, imageCount: images },
          };
    }
    if (platform === "DYNAMIC_ZSXQ" && /^\/group\/\d+$/.test(location.pathname)) {
      const cards = Array.from(document.querySelectorAll<HTMLElement>("app-topic")).filter((card) => {
        const body = normalize(card.querySelector<HTMLElement>("app-talk-content .content")?.innerText || "");
        return body.startsWith(normalize(data.title)) && body.includes(normalize(data.content).slice(0, 24));
      });
      const imageCount = cards.length === 1 ? cards[0].querySelectorAll("app-image-gallery img.item").length : 0;
      if (cards.length === 1 && imageCount === data.images.length)
        return {
          status: "published",
          code: "FEED_ENTRY_CONFIRMED_NO_LINK",
          evidence: { ...evidence, groupUrl: currentUrl, matchedCards: 1, imageCount },
        };
    }
    if (platform === "DYNAMIC_DOUYIN" && location.pathname.includes("/content/manage")) {
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[class*="video-card-"]')).filter(
        (card) =>
          card.className.includes("video-card-") &&
          card.innerText.includes(data.title) &&
          card.innerText.includes(data.content.slice(0, 24)) &&
          /已发布/.test(card.innerText),
      );
      if (cards.length)
        return {
          status: "result_unconfirmed",
          code: "MANAGER_ENTRY_FOUND_NO_ID",
          evidence: { ...evidence, matchedCards: cards.length, managerUrl: location.href },
        };
    }
    if (platform === "DYNAMIC_REDNOTE" && location.pathname === "/new/note-manager") {
      const active = document.querySelector<HTMLElement>(".tab-item--active")?.innerText.trim();
      const cards = Array.from(document.querySelectorAll<HTMLElement>(".note-card"));
      const exact = cards.filter(
        (card) => card.querySelector<HTMLElement>(".note-card__title")?.innerText.trim() === data.title,
      );
      const impression = exact.length === 1 ? exact[0].getAttribute("data-impression") : null;
      let noteId = "";
      try {
        noteId =
          (JSON.parse(impression || "null") as { noteTarget?: { value?: { noteId?: string } } } | null)?.noteTarget
            ?.value?.noteId || "";
      } catch {
        // A changed platform card must not be mistaken for a confirmed post.
      }
      const managerEvidence = { ...evidence, activeFilter: active, matchedCards: exact.length, noteId };
      return active === "已发布" && /^[a-f\d]{24}$/i.test(noteId)
        ? {
            status: "published",
            code: "WORK_ID_CONFIRMED",
            evidence: { ...managerEvidence, managerUrl: location.href },
          }
        : { status: "result_unconfirmed", code: "PUBLISH_RESULT_NOT_CONFIRMED", evidence: managerEvidence };
    }
    // A platform success view with a concrete work link is sufficient. A click alone never is.
    const success = /发布成功|发表成功|发送成功|Post sent|Your post was sent|已发布/.test(allText);
    const review = /审核中|等待审核|提交审核|审核处理中|under review/.test(allText);
    const toast = document.querySelector<HTMLElement>('[data-testid="toast"], [role="alert"], [role="status"]');
    const toastLink = toast?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    if (platform === "DYNAMIC_X") {
      const ownPost = deep(document, 'article[data-testid="tweet"]').find(
        (node) =>
          normalize((node as HTMLElement).innerText).includes(normalize(data.title)) &&
          normalize((node as HTMLElement).innerText).includes(normalize(data.content).slice(0, 24)),
      );
      const ownLink = ownPost?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
      if (toast && /Post sent|Your post was sent/.test(toast.innerText) && toastLink)
        return { status: "published", code: "WORK_LINK_CONFIRMED", evidence: { ...evidence, workUrl: toastLink.href } };
      if (ownLink?.href.includes("/status/"))
        return { status: "published", code: "WORK_LINK_CONFIRMED", evidence: { ...evidence, workUrl: ownLink.href } };
      return { status: "result_unconfirmed", code: "PUBLISH_RESULT_NOT_CONFIRMED", evidence };
    }
    const workLink = links.find((link) =>
      platform === "DYNAMIC_X"
        ? /\/status\/\d+/.test(link.href)
        : platform === "DYNAMIC_REDNOTE"
          ? /\/explore\/[\da-f]+|\/discovery\/item\/[\da-f]+/.test(link.href)
          : true,
    );
    if (success && workLink)
      return { status: "published", code: "WORK_LINK_CONFIRMED", evidence: { ...evidence, workUrl: workLink.href } };
    if (review && !document.querySelector('[contenteditable="true"]'))
      return { status: "submitted_pending_review", code: "PLATFORM_REVIEW_PENDING", evidence };
    return { status: "result_unconfirmed", code: "PUBLISH_RESULT_NOT_CONFIRMED", evidence };
  }

  if (platform === "DYNAMIC_WEIXIN")
    return { status: "needs_attention", code: "WEIXIN_MASS_SEND_NOT_IMPLEMENTED", evidence };
  if (platform === "DYNAMIC_WEIXINCHANNEL") {
    const titleInput = deep(document, 'input[placeholder*="标题"]').find(visible) as HTMLInputElement | undefined;
    const bodyEditor = deep(document, 'div[data-placeholder*="添加描述"], div.input-editor').find(visible) as
      | HTMLElement
      | undefined;
    const expectedBody = `${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
    evidence.titleMatched = titleInput?.value.trim() === data.title;
    evidence.bodyMatched = bodyEditor?.innerText.trim() === expectedBody.trim();
    if (!evidence.titleMatched || !evidence.bodyMatched)
      return { status: "needs_attention", code: "PREPARED_CONTENT_CHANGED", evidence };
    const fileInputs = deep(document, 'input[type="file"][accept*="image"]') as HTMLInputElement[];
    const filesMatch = fileInputs.some(
      (input) =>
        input.files?.length === data.images.length &&
        data.images.every(
          (image, index) =>
            input.files?.[index]?.name === image.name &&
            (image.size === undefined || input.files?.[index]?.size === image.size),
        ),
    );
    const sources = Array.isArray(preparedEvidence.imageSources)
      ? preparedEvidence.imageSources.filter((source): source is string => typeof source === "string" && !!source)
      : [];
    const currentSources = new Set(
      deep(document, "img")
        .filter(visible)
        .map((node) => (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src),
    );
    const previewsMatch =
      sources.length === data.images.length && sources.every((source) => currentSources.has(source));
    evidence.imageCountExpected = data.images.length;
    evidence.mediaMatchedByFiles = filesMatch;
    evidence.mediaMatchedByPreviews = previewsMatch;
    if (!filesMatch && !previewsMatch) return { status: "needs_attention", code: "PREPARED_MEDIA_CHANGED", evidence };
  }
  const title = deep(document, 'input[placeholder*="标题"]').find(visible) as HTMLInputElement | undefined;
  const editor = deep(document, '[contenteditable="true"]').find(
    (node) =>
      visible(node) && normalize((node as HTMLElement).innerText).includes(normalize(data.content).slice(0, 24)),
  ) as HTMLElement | undefined;
  const titleMatched = title
    ? normalize(title.value) === normalize(data.title)
    : normalize(allText).includes(normalize(data.title));
  const bodyMatched = editor
    ? normalize(editor.innerText).includes(normalize(data.content).slice(0, 36))
    : normalize(allText).includes(normalize(data.content).slice(0, 36));
  evidence.titleMatched = titleMatched;
  evidence.bodyMatched = bodyMatched;
  evidence.imageCountExpected = data.images.length;
  if (!titleMatched || !bodyMatched) return { status: "needs_attention", code: "PREPARED_CONTENT_CHANGED", evidence };
  let imageCount: number | undefined;
  if (platform === "DYNAMIC_REDNOTE")
    imageCount = document.querySelectorAll(".img-list .img-container img.preview").length;
  if (platform === "DYNAMIC_TOUTIAO")
    imageCount = Number(
      document.querySelector<HTMLElement>(".upload-box")?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] || 0,
    );
  if (platform === "DYNAMIC_ZSXQ") imageCount = document.querySelectorAll(".upload-container .image-item img").length;
  if (platform === "DYNAMIC_MAIMAI")
    imageCount = Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')).filter((image) =>
      image.closest(".flex.flex-row.gap-1"),
    ).length;
  if (platform === "DYNAMIC_X") imageCount = document.querySelectorAll('[data-testid="attachments"] img').length;
  if (platform === "DYNAMIC_OKJIKE") {
    const root = editor?.closest("form") || editor?.closest('[role="dialog"]') || editor?.parentElement?.parentElement;
    imageCount = root
      ? new Set(
          Array.from(root.querySelectorAll<HTMLImageElement>("img")).filter((image) => image.currentSrc || image.src),
        ).size
      : undefined;
  }
  if (platform === "DYNAMIC_DOUYIN")
    imageCount = new Set(
      Array.from(document.querySelectorAll<HTMLImageElement>("img"))
        .filter(
          (image) =>
            image.complete &&
            image.naturalWidth >= 80 &&
            image.naturalHeight >= 80 &&
            String(image.parentElement?.className || "").startsWith("img-"),
        )
        .map((image) => image.currentSrc || image.src),
    ).size;
  evidence.imageCount = imageCount;
  if (imageCount !== undefined && imageCount !== data.images.length)
    return { status: "needs_attention", code: "PREPARED_MEDIA_CHANGED", evidence };

  let button: HTMLElement | undefined;
  if (platform === "DYNAMIC_WEIXINCHANNEL") {
    const publishButtons = deep(document, "button")
      .filter(visible)
      .filter((node) => /^(发表|发布)$/.test((node as HTMLElement).innerText.trim()));
    if (publishButtons.length !== 1)
      return {
        status: "needs_attention",
        code: "PUBLISH_CONTROL_NOT_READY",
        evidence: { ...evidence, publishButtonCount: publishButtons.length },
      };
    button = publishButtons[0] as HTMLElement;
  } else if (platform === "DYNAMIC_REDNOTE") {
    button =
      document.querySelector<HTMLElement>('xhs-publish-btn[is-publish="true"][submit-disabled="false"]') || undefined;
    evidence.customPublishControl = button?.outerHTML.slice(0, 500);
  } else if (platform === "DYNAMIC_X") {
    button = deep(document, '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]').find(visible) as
      | HTMLElement
      | undefined;
  } else if (platform === "DYNAMIC_TOUTIAO") {
    button = deep(document, "button.publish-content").find(visible) as HTMLElement | undefined;
  } else if (platform === "DYNAMIC_ZSXQ") {
    button = deep(document, ".submit-btn").find(visible) as HTMLElement | undefined;
  }
  if (!button) {
    const label =
      platform === "DYNAMIC_OKJIKE"
        ? /^(发送|发布)$/
        : platform === "DYNAMIC_MAIMAI"
          ? /^发动态$/
          : platform === "DYNAMIC_WEIXINCHANNEL"
            ? /^(发表|发布)$/
            : /^发布$/;
    button = deep(document, 'button, [role="button"], [class*="publish"], [class*="submit"]')
      .filter(visible)
      .find(
        (node) =>
          label.test((node as HTMLElement).innerText.trim()) && !/定时|暂存|草稿/.test((node as HTMLElement).innerText),
      ) as HTMLElement | undefined;
  }
  evidence.buttons = deep(document, 'button, [role="button"], [class*="publish"], [class*="submit"]')
    .filter(visible)
    .map((node) => ({
      text: (node as HTMLElement).innerText.trim().slice(0, 45),
      disabled: (node as HTMLButtonElement).disabled,
      className: String(node.className).slice(0, 80),
    }))
    .filter((item) => item.text)
    .slice(-25);
  if (!button || (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true")
    return { status: "needs_attention", code: "PUBLISH_CONTROL_NOT_READY", evidence };
  evidence.buttonText = platform === "DYNAMIC_REDNOTE" ? "发布" : button.innerText.trim();
  if (platform === "DYNAMIC_REDNOTE") {
    // Its closed-shadow button emits this composed event; clicking the host is a no-op.
    button.dispatchEvent(new CustomEvent("publish", { bubbles: true, composed: true }));
  } else {
    button.click();
  }
  return { status: "clicked", code: "PUBLISH_CLICKED_CHECK_RESULT", evidence };
}
