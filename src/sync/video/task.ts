import type { VideoData } from "../common";

export interface VideoTaskResult {
  status:
    | "account_verified"
    | "ready"
    | "filled"
    | "draft_saved"
    | "clicked"
    | "needs_attention"
    | "result_unconfirmed"
    | "published"
    | "submitted_pending_review";
  code: string;
  evidence: Record<string, unknown>;
}

/** Injected in the original editor. Legacy handlers do the actual upload/fill.
 * This adapter admits an empty editor once, observes selected files, verifies
 * the resulting editor and never repeats an upload during resume/reconcile. */
export async function videoTaskStep(
  platform: string,
  data: VideoData,
  mode:
    | "account"
    | "gate"
    | "inspect"
    | "inspect_fields"
    | "configure_draft"
    | "open_cover"
    | "finish_cover"
    | "open_horizontal_cover"
    | "upload_cover"
    | "upload_horizontal_cover"
    | "click"
    | "save_draft"
    | "verify_draft"
    | "repair_title"
    | "open_draft_manager"
    | "verify",
  taskId: string,
  prepared: Record<string, unknown> = {},
): Promise<VideoTaskResult> {
  const origins: Record<string, string> = {
    VIDEO_REDNOTE: "https://creator.xiaohongshu.com",
    VIDEO_DOUYIN: "https://creator.douyin.com",
    VIDEO_WEIXINCHANNEL: "https://channels.weixin.qq.com",
  };
  const shadowFor = (node: Element): ShadowRoot | null => {
    if (node.shadowRoot) return node.shadowRoot;
    try {
      return typeof chrome !== "undefined" && chrome.dom?.openOrClosedShadowRoot
        ? chrome.dom.openOrClosedShadowRoot(node as HTMLElement)
        : null;
    } catch {
      return null;
    }
  };
  const deep = (
    root: Document | ShadowRoot,
    selector: string,
    visited = new Set<Document | ShadowRoot>(),
  ): Element[] => {
    if (visited.has(root)) return [];
    visited.add(root);
    const result = Array.from(root.querySelectorAll(selector));
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const shadow = shadowFor(node);
      if (shadow) result.push(...deep(shadow, selector, visited));
      if (node.tagName === "IFRAME") {
        try {
          const child = (node as HTMLIFrameElement).contentDocument;
          if (child) result.push(...deep(child, selector, visited));
        } catch {
          // Cross-origin frames are outside this platform document.
        }
      }
    }
    return Array.from(new Set(result));
  };
  const norm = (value: string) =>
    value
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (node: Element) => {
    if (!Array.from(node.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) return false;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    return !style || (style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none");
  };
  const all = (selector: string) => deep(document, selector);
  const evidence: Record<string, unknown> = { url: location.origin + location.pathname, taskId };
  const result = (status: VideoTaskResult["status"], code: string): VideoTaskResult => ({ status, code, evidence });
  if (!origins[platform] || location.origin !== origins[platform])
    return result("needs_attention", "PLATFORM_ORIGIN_CHANGED");
  if (mode !== "account" && !data.expectedAccountId) return result("needs_attention", "ACCOUNT_UNVERIFIED");
  const key = `fastpublish.video.${taskId}`;
  interface Observation {
    selected: string[];
    pending: number;
    startedAt: number;
    clickAttempted?: boolean;
    draftAttempted?: boolean;
    draftSaveConfirmed?: boolean;
    coverCheckRetried?: boolean;
    coverSelections?: { primary?: string; horizontal?: string };
    coverBeforeEdit?: string[];
    repairCoverRole?: "primary" | "horizontal";
  }
  let observation: Observation | null;
  try {
    observation = JSON.parse(sessionStorage.getItem(key) || "null");
  } catch {
    return result("needs_attention", "VIDEO_STATE_UNAVAILABLE");
  }
  const save = (value: Observation) => sessionStorage.setItem(key, JSON.stringify(value));

  // Read only, authenticated account endpoints already used by the extension.
  let accountId = "";
  let username = "";
  if (data.expectedAccountId || mode === "account") {
    try {
      if (platform === "VIDEO_REDNOTE") {
        const response = await fetch("/api/galaxy/user/info", {
          credentials: "include",
          signal: AbortSignal.timeout(8000),
        });
        const body = response.ok ? await response.json() : null;
        evidence.accountRead = {
          httpStatus: response.status,
          responseCode: typeof body?.code === "number" ? body.code : null,
        };
        if (body?.code === 0 && body?.success === true) {
          accountId = body.data?.userId || "";
          username = typeof body.data?.userName === "string" ? body.data.userName : "";
        }
      } else if (platform === "VIDEO_DOUYIN") {
        const response = await fetch("/web/api/media/user/info/", {
          credentials: "include",
          signal: AbortSignal.timeout(8000),
        });
        const body = response.ok ? await response.json() : null;
        evidence.accountRead = {
          httpStatus: response.status,
          responseCode: typeof body?.status_code === "number" ? body.status_code : null,
          // Names only: never return the raw user object or session fields.
          responseKeys:
            body && typeof body === "object"
              ? Object.keys(body)
                  .filter((key) => /^[a-zA-Z_]+$/.test(key))
                  .slice(0, 20)
              : [],
          userKeys:
            body?.user && typeof body.user === "object"
              ? Object.keys(body.user)
                  .filter((key) => /^[a-zA-Z_]+$/.test(key))
                  .slice(0, 20)
              : [],
        };
        accountId = typeof body?.user?.sec_uid === "string" ? body.user.sec_uid : "";
        username = typeof body?.user?.nickname === "string" ? body.user.nickname : "";
      } else {
        // Candidate creator-account contract; live validation is still required.
        // Reference: github.com/wordweb/Get-Tencent-Video-Live-Barrage-Gifts/blob/main/webapi.py
        // finderUser is the video-channel identity; userAttr is a different WeChat user.
        const response = await fetch("/cgi-bin/mmfinderassistant-bin/auth/auth_data", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            timestamp: Date.now(),
            _log_finder_uin: "",
            _log_finder_id: "",
            rawKeyBuff: null,
            pluginSessionId: null,
            scene: 7,
            reqScene: 7,
          }),
        });
        evidence.accountRead = {
          method: "authenticated_endpoint",
          httpStatus: response.status,
          identitySource: "finderUser.finderUsername",
          contractStatus: "candidate_not_live_verified",
          loginState: "not_determined",
        };
        const body = response.ok ? await response.json() : null;
        const responseCode = typeof body?.errCode === "number" ? body.errCode : null;
        const candidate = body?.data?.finderUser?.finderUsername;
        const validIdentity = typeof candidate === "string" && /^[A-Za-z0-9_@.-]{1,200}$/.test(candidate);
        evidence.accountRead = {
          ...(evidence.accountRead as Record<string, unknown>),
          responseCode,
          identityEvidence:
            !response.ok || responseCode !== 0
              ? "request_not_successful"
              : validIdentity
                ? "observed"
                : typeof candidate === "string" && candidate
                  ? "invalid_identity"
                  : "missing_identity",
        };
        if (response.ok && responseCode === 0 && validIdentity) {
          accountId = candidate;
          const name = body.data.finderUser.nickname;
          username = typeof name === "string" ? name.slice(0, 100) : "";
        }
      }
    } catch (error) {
      evidence.accountRead = {
        ...(evidence.accountRead as Record<string, unknown> | undefined),
        errorType: error instanceof Error ? error.name : "UNKNOWN",
      };
    }
    evidence.accountId = accountId || null;
    evidence.username = username || null;
    if (mode === "account")
      return result(
        accountId ? "account_verified" : "needs_attention",
        accountId ? "ACCOUNT_READ_ONLY" : "ACCOUNT_UNVERIFIED",
      );
    if (accountId !== data.expectedAccountId)
      return result("needs_attention", accountId ? "ACCOUNT_MISMATCH" : "ACCOUNT_UNVERIFIED");
  }

  if (mode === "open_draft_manager") {
    const controls = all(".breadcrumb-name")
      .filter(visible)
      .filter((node) => norm(node.textContent || "") === "视频管理");
    if (controls.length !== 1) return result("needs_attention", "DRAFT_MANAGER_CONTROL_NOT_READY");
    (controls[0] as HTMLElement).click();
    return result("clicked", "DRAFT_MANAGER_OPENED");
  }
  if (mode === "verify_draft" && observation?.draftAttempted && observation.draftSaveConfirmed) {
    evidence.draftClickAttempted = true;
    evidence.draftSaveConfirmed = true;
    return result("draft_saved", "DRAFT_SAVE_CONFIRMED");
  }
  if (mode === "verify_draft" && platform !== "VIDEO_WEIXINCHANNEL") {
    evidence.visibleTextTail = norm(document.body?.innerText || "").slice(-2000);
    evidence.visibleTextHead = norm(document.body?.innerText || "").slice(0, 2500);
    evidence.draftLabels = all("*")
      .filter(visible)
      .filter((n) => n.children.length === 0 && /草稿/.test(norm(n.textContent || "")))
      .map((n) => ({ text: norm(n.textContent || ""), tag: n.tagName, className: n.getAttribute("class") }))
      .slice(0, 20);
    evidence.draftNavigation = all("a")
      .filter(visible)
      .map((n) => ({ text: norm(n.textContent || ""), path: (n as HTMLAnchorElement).pathname }))
      .filter((n) => /草稿|管理|作品/.test(n.text));
    const attempt = JSON.parse(sessionStorage.getItem(`fastpublish.video.${taskId}`) || "null") as {
      draftAttempted?: boolean;
    } | null;
    evidence.draftClickAttempted = attempt?.draftAttempted === true || prepared.draftClickAttempted === true;
    const messages = all('[role="alert"], [role="status"], [class*="toast"], [class*="message"], [class*="Message"]')
      .filter(visible)
      .map((n) => norm(n.textContent || ""));
    evidence.draftMessages = messages.filter((t) => /草稿|暂存|保存/.test(t)).slice(0, 10);
    const saved = messages.some((t) =>
      /(?:草稿|暂存).{0,12}(?:已保存|成功)|(?:已保存|保存成功).{0,12}(?:草稿|暂存)/.test(t),
    );
    if (evidence.draftClickAttempted && saved) return result("draft_saved", "DRAFT_SAVE_CONFIRMED");
    if (platform === "VIDEO_DOUYIN" && evidence.draftClickAttempted) {
      const prompt = /你还有上次未发布的视频，是否继续编辑/.test(norm(document.body?.innerText || ""));
      const continueButtons = all("button, span, div")
        .filter(visible)
        .filter((n) => n.children.length === 0 && norm(n.textContent || "") === "继续编辑");
      if (prompt && continueButtons.length === 1 && prepared.draftReopened !== true) {
        evidence.draftReopened = true;
        (continueButtons[0] as HTMLElement).click();
        return result("result_unconfirmed", "DRAFT_REOPENING");
      }
      if (prepared.draftReopened === true) {
        const titles = all('input[placeholder*="标题"]').filter(visible) as HTMLInputElement[];
        const body = all('[contenteditable="true"]').find(visible) as HTMLElement | undefined;
        const actual = norm(body?.innerText || "");
        const expected = norm([data.content, ...(data.tags || []).map((t) => `#${t}`)].join(" "));
        evidence.reopenedTitleMatched = titles.length === 1 && norm(titles[0].value) === norm(data.title);
        evidence.reopenedBodyMatched = actual === expected;
        evidence.reopenedVideoPresent =
          all("video, [class*='video-card'], [class*='videoCard']").some(visible) ||
          /重新上传/.test(norm(document.body?.innerText || ""));
        evidence.draftStorage = "platform_browser_draft";
        if (evidence.reopenedTitleMatched && evidence.reopenedBodyMatched && evidence.reopenedVideoPresent)
          return result("draft_saved", "DRAFT_REOPEN_CONFIRMED");
      }
    }
    const titleNodes = all("*")
      .filter(visible)
      .filter((n) => n.children.length === 0 && norm(n.textContent || "") === norm(data.title));
    const draftContext =
      /draft/i.test(location.href) ||
      all("*")
        .filter(visible)
        .some((n) => n.children.length === 0 && /^(草稿箱|草稿|草稿管理)$/.test(norm(n.textContent || "")));
    const cards = titleNodes
      .map((n) => n.closest('[class*="note"], [class*="card"], [class*="item"], li') || n.parentElement)
      .filter(Boolean);
    evidence.draftTitleMatches = titleNodes.length;
    evidence.draftManagerContext = draftContext;
    if (
      evidence.draftClickAttempted &&
      draftContext &&
      titleNodes.length === 1 &&
      cards.some((n) => /刚刚|\d{2}:\d{2}/.test(n?.textContent || ""))
    )
      return result("draft_saved", "DRAFT_MANAGER_CONFIRMED");
    if (evidence.draftClickAttempted && (!draftContext || !titleNodes.length) && prepared.draftTabVisited !== true) {
      const tabs = all("a, button, [role='tab'], span, div")
        .filter(visible)
        .filter(
          (n) => n.children.length === 0 && /^(草稿箱|草稿)(?:\s*[（(]?\d+[）)]?)?$/.test(norm(n.textContent || "")),
        );
      if (tabs.length === 1) {
        evidence.draftTabVisited = true;
        (tabs[0] as HTMLElement).click();
        return result("result_unconfirmed", "DRAFT_MANAGER_NAVIGATING");
      }
    }
    if (evidence.draftClickAttempted && !titleNodes.length && prepared.draftManagerVisited !== true) {
      const managers = all("a, span, div")
        .filter(visible)
        .filter((n) => n.children.length === 0 && /^(作品管理|内容管理)$/.test(norm(n.textContent || "")));
      if (managers.length === 1) {
        evidence.draftManagerVisited = true;
        (managers[0] as HTMLElement).click();
        return result("result_unconfirmed", "DRAFT_MANAGER_NAVIGATING");
      }
    }
    if (
      platform === "VIDEO_DOUYIN" &&
      evidence.draftClickAttempted &&
      location.pathname.endsWith("/content/manage") &&
      !titleNodes.length &&
      prepared.draftUploadVisited !== true
    ) {
      evidence.draftUploadVisited = true;
      location.href = "https://creator.douyin.com/creator-micro/content/upload";
      return result("result_unconfirmed", "DRAFT_MANAGER_NAVIGATING");
    }
    return result("result_unconfirmed", "DRAFT_RESULT_NOT_CONFIRMED");
  }
  if (mode === "verify_draft") {
    evidence.managerFrameCount = all("iframe").length;
    evidence.managerShadowRootCount = all("*").filter((node) => node.shadowRoot).length;
    evidence.managerEmptyState = all("*")
      .filter(visible)
      .filter((node) => node.children.length === 0)
      .map((node) => norm(node.textContent || ""))
      .filter((text) => /^(暂无|没有|加载|请求失败|网络异常|内容管理|视频管理|草稿箱|发表记录)/.test(text))
      .slice(0, 15);
    evidence.draftMessages = all('[role="alert"], [role="status"], .weui-desktop-toast')
      .filter(visible)
      .map((node) => norm(node.textContent || "").slice(0, 180))
      .filter((text) => /草稿|保存/.test(text));
    evidence.draftEditorTitleMatched = all('input[placeholder*="标题"]')
      .filter(visible)
      .some((node) => norm((node as HTMLInputElement).value || "") === norm(data.title));
    const draftBody = all('div[data-placeholder="添加描述"]')
      .filter(visible)
      .map((node) => norm((node as HTMLElement).innerText || ""));
    const expectedDraftBody = norm([data.content, ...(data.tags || []).map((tag) => `#${tag}`)].join(" "));
    evidence.draftEditorBodyMatched = draftBody.some((body) => body === expectedDraftBody);
    evidence.draftEditorVideo = all("video")
      .filter(visible)
      .map((node) => {
        const video = node as HTMLVideoElement;
        return {
          readyState: video.readyState,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          width: video.videoWidth,
          height: video.videoHeight,
          hasSource: !!(video.currentSrc || video.src),
        };
      });
    evidence.draftEditorCovers = all(".vertical-cover-wrap img").filter(visible).length;
    evidence.titleValidationErrors = all("*")
      .filter(visible)
      .filter((node) => node.children.length === 0)
      .map((node) => norm(node.textContent || ""))
      .filter((text) => /短标题.*(?:不能|不支持|16|特殊字符)|标题.*(?:特殊字符|16个|16字)/.test(text))
      .slice(0, 5);
    if ((evidence.titleValidationErrors as string[]).length && evidence.draftEditorTitleMatched) {
      evidence.draftTitleRejected = true;
      return result("needs_attention", "DRAFT_TITLE_REJECTED");
    }
    evidence.draftDialogs = all('[role="dialog"], .common-dialog, .finder-common-dialog')
      .filter(visible)
      .map((node) => ({
        className: node.getAttribute("class") || "",
        text: norm(node.textContent || "").slice(0, 500),
      }));
    evidence.draftPageLabels = all("*")
      .filter(visible)
      .filter((node) => node.children.length === 0)
      .map((node) => norm(node.textContent || ""))
      .filter((text) => /草稿|保存|内容管理|作品管理/.test(text))
      .slice(0, 20);
    evidence.draftNavigation = all("a[href]")
      .filter(visible)
      .map((node) => {
        const link = node as HTMLAnchorElement;
        return {
          text: norm(node.textContent || "").slice(0, 60),
          path: link.origin === location.origin ? link.pathname : "",
        };
      })
      .filter((link) => link.path && /内容|视频|草稿|管理/.test(link.text))
      .slice(0, 15);
    evidence.draftMenuControls = all("*")
      .filter(visible)
      .filter(
        (node) =>
          node.children.length === 0 &&
          /^(内容管理|视频管理|内容|视频|草稿|草稿箱|动态)$/.test(norm(node.textContent || "")),
      )
      .slice(0, 15)
      .map((node) => ({
        tag: node.tagName,
        text: norm(node.textContent || ""),
        className: node.getAttribute("class") || "",
        parentClass: node.parentElement?.getAttribute("class") || "",
      }));
    evidence.managerTabs = all('button, [role="tab"], a, span, div')
      .filter(visible)
      .filter((node) => node.children.length === 0 && /草稿|已发表|全部|已发布/.test(norm(node.textContent || "")))
      .slice(0, 20)
      .map((node) => ({
        text: norm(node.textContent || "").slice(0, 100),
        className: node.getAttribute("class") || "",
        parentClass: node.parentElement?.getAttribute("class") || "",
      }));
    evidence.draftCandidates = all("*")
      .filter(visible)
      .filter(
        (node) =>
          node.children.length === 0 &&
          (norm(node.textContent || "") === norm(data.title) ||
            norm(node.textContent || "").includes(norm(data.content).slice(0, 30))),
      )
      .slice(0, 5)
      .map((node) => ({
        className: node.getAttribute("class") || "",
        parentClass: node.parentElement?.getAttribute("class") || "",
        parentText: norm(node.parentElement?.textContent || "").slice(0, 400),
        grandparentClass: node.parentElement?.parentElement?.getAttribute("class") || "",
        grandparentText: norm(node.parentElement?.parentElement?.textContent || "").slice(0, 600),
        tag: node.tagName,
      }));
    const draftBoxHeading = all(".title-name").some(
      (node) => visible(node) && norm(node.textContent || "") === "草稿箱",
    );
    const draftCards = all(".post-title")
      .filter(visible)
      .filter((node) => norm(node.textContent || "") === expectedDraftBody);
    evidence.draftBoxHeadingVerified = draftBoxHeading;
    evidence.draftMatchedCards = draftCards.length;
    if (
      platform === "VIDEO_WEIXINCHANNEL" &&
      location.pathname === "/platform/post/draftListManager" &&
      draftBoxHeading &&
      draftCards.length === 1
    ) {
      const card = draftCards[0];
      const timestamps = Array.from(card.parentElement?.querySelectorAll("span") || [])
        .map((node) => norm(node.textContent || ""))
        .filter((text) => /^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/.test(text));
      if (timestamps.length === 1) {
        evidence.draftTimeLabel = timestamps[0];
        evidence.draftReadback = "unique_exact_body_in_account_draft_box";
        evidence.draftBodyMatched = true;
        return result("draft_saved", "DRAFT_READBACK_CONFIRMED");
      }
    }
    return result("result_unconfirmed", "DRAFT_RESULT_NOT_CONFIRMED");
  }

  if (mode === "verify") {
    // Only a work-specific site receipt is authoritative. Generic success text,
    // an arbitrary manager card, and a title match alone cannot confirm a post.
    const expectedId = typeof prepared.workId === "string" ? prepared.workId : "";
    const cards = all(".note-card, [class*='video-card-'], [data-object-id]");
    const matches = cards.filter((card) => {
      const title = card.querySelector<HTMLElement>(".note-card__title, [class*='title']")?.innerText;
      return norm(title || "") === norm(data.title);
    });
    evidence.matchedCards = matches.length;
    if (matches.length === 1 && expectedId) {
      const card = matches[0];
      const text = (card as HTMLElement).innerText;
      const links = Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"));
      const link = links.find((node) => {
        try {
          const url = new URL(node.href);
          return (
            ["www.xiaohongshu.com", "www.douyin.com", "channels.weixin.qq.com"].includes(url.hostname) &&
            url.pathname.split("/").includes(expectedId)
          );
        } catch {
          return false;
        }
      });
      let cardId = card.getAttribute("data-object-id") || "";
      if (platform === "VIDEO_REDNOTE") {
        try {
          cardId = JSON.parse(card.getAttribute("data-impression") || "null")?.noteTarget?.value?.noteId || "";
        } catch {
          /* A changed manager card cannot prove publication. */
        }
      }
      if (cardId === expectedId || link) {
        evidence.workId = expectedId;
        if (link) evidence.workUrl = link.origin + link.pathname;
        if (/审核中|待审核/.test(text)) return result("submitted_pending_review", "PLATFORM_REVIEW_PENDING");
        if (/已发布|已发表/.test(text) && !/私密|仅自己|好友可见/.test(text))
          return result("published", "WORK_ID_CONFIRMED");
      }
    }
    const receipt = all("[role='alert'], [role='status'], .publish-success").find((node) =>
      /发布成功|发表成功/.test(node.textContent || ""),
    );
    const receiptLink = receipt?.querySelector<HTMLAnchorElement>("a[href]");
    if (receiptLink) {
      const url = new URL(receiptLink.href);
      const match =
        platform === "VIDEO_REDNOTE" && url.hostname === "www.xiaohongshu.com"
          ? url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})$/i)
          : platform === "VIDEO_DOUYIN" && url.hostname === "www.douyin.com"
            ? url.pathname.match(/^\/video\/(\d+)$/)
            : null;
      if (match) {
        evidence.workId = match[1];
        evidence.workUrl = url.origin + url.pathname;
        // A success receipt proves submission, not that platform review is over.
        return result("submitted_pending_review", "PLATFORM_RECEIPT_CONFIRMED");
      }
    }
    return result("result_unconfirmed", "PUBLISH_RESULT_NOT_CONFIRMED");
  }

  const titleSelector =
    platform === "VIDEO_DOUYIN"
      ? 'input[placeholder*="作品标题"], input[placeholder*="标题"]'
      : platform === "VIDEO_REDNOTE"
        ? 'input[placeholder*="标题"], input[type="text"]'
        : 'input[placeholder*="标题"]';
  const title = all(titleSelector).find(visible) as HTMLInputElement | undefined;
  const editor = all(
    platform === "VIDEO_WEIXINCHANNEL" ? 'div[data-placeholder="添加描述"]' : '[contenteditable="true"]',
  ).find(visible) as HTMLElement | undefined;
  const inputs = all('input[type="file"]') as HTMLInputElement[];
  const previews = all("video")
    .filter(visible)
    .map((node) => {
      const video = node as HTMLVideoElement;
      return video.currentSrc || video.src || video.poster;
    })
    .filter(Boolean);
  const coverSelectors =
    platform === "VIDEO_WEIXINCHANNEL"
      ? ".cover-preview-wrap img, .horizon-img-wrap img"
      : platform === "VIDEO_REDNOTE"
        ? ".uploadCover img, .cover img, [class*='cover'] img"
        : ".content-upload-new img, [class*='cover'] img";
  const covers = all(coverSelectors)
    .filter(visible)
    .map((node) => (node as HTMLImageElement).src)
    .filter(Boolean);
  const required = [data.video, data.cover, data.verticalCover, data.horizontalCover]
    .filter(Boolean)
    .map((file) => file!.sha256);
  const fingerprint = async (source: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  // Preview URLs can contain temporary access signatures. Keep only fingerprints.
  const videoFingerprints = await Promise.all(previews.map(fingerprint));
  const coverFingerprints = await Promise.all(covers.map(fingerprint));
  const coverRoots =
    platform === "VIDEO_REDNOTE"
      ? all(".cover-plugin-preview .cover--column").filter(visible)
      : platform === "VIDEO_DOUYIN"
        ? all('[class*="coverControl-"]').filter(visible)
        : [];
  const coverPhotos: string[] = [];
  for (const root of coverRoots) {
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
      if (img.naturalWidth >= 100 && img.naturalHeight >= 100 && (img.currentSrc || img.src))
        coverPhotos.push(img.currentSrc || img.src);
    }
    for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
      const rect = node.getBoundingClientRect?.();
      if (rect && rect.width >= 64 && rect.height >= 64) {
        const background = getComputedStyle(node).backgroundImage;
        if (background.includes("url(")) coverPhotos.push(background);
      }
    }
  }
  if (coverRoots.length) {
    const photos = await Promise.all(Array.from(new Set(coverPhotos)).map(fingerprint));
    coverFingerprints.splice(0, coverFingerprints.length, ...photos);
  }
  evidence.videoSources = videoFingerprints;
  evidence.coverSources = coverFingerprints;
  evidence.titleMatched = norm(title?.value || "") === norm(data.title);
  const actualBody = norm(editor?.innerText || "");
  const expectedTopics = (data.tags || []).map((tag) => `#${tag}`);
  const bodyWithTopics = norm([data.content, ...expectedTopics].join(" "));
  const nativeTopicNodes =
    platform === "VIDEO_REDNOTE" && editor
      ? Array.from(editor.querySelectorAll<HTMLElement>('.tiptap-topic[contenteditable="false"]'))
      : platform === "VIDEO_WEIXINCHANNEL" && editor
        ? Array.from(editor.querySelectorAll<HTMLElement>("span.hl.topic"))
        : [];
  const nativeTopicNames = nativeTopicNodes.map((node) =>
    norm(node.textContent || "")
      .replace(/^#/, "")
      .replace(/\[话题\]#$/, ""),
  );
  evidence.nativeTopicNames = nativeTopicNames;
  evidence.nativeTopicsMatched =
    !!expectedTopics.length &&
    nativeTopicNames.length === expectedTopics.length &&
    nativeTopicNames.every((tag, i) => tag === data.tags?.[i]);
  const expectedBody = norm(data.content);
  const suffix = actualBody.startsWith(expectedBody)
    ? actualBody
        .slice(expectedBody.length)
        .replace(/\[话题\]#/g, "")
        .replace(/\s/g, "")
    : "";
  evidence.bodyMatched =
    actualBody === expectedBody ||
    actualBody === bodyWithTopics ||
    (evidence.nativeTopicsMatched === true &&
      actualBody.startsWith(expectedBody) &&
      suffix === expectedTopics.join(""));
  evidence.topicTextChecks = expectedTopics.map((topic) => ({ topic, present: actualBody.includes(topic) }));
  evidence.topicTextMatched = expectedTopics.every((topic) => actualBody.includes(topic));
  evidence.originalRequested = data.original ?? null;
  evidence.originalControlSupported = platform === "VIDEO_WEIXINCHANNEL";
  evidence.scheduleRequested = data.scheduledPublishTime === 0 ? "immediate" : (data.scheduledPublishTime ?? null);
  const rednoteSwitchState = (label: string): boolean | null => {
    if (platform !== "VIDEO_REDNOTE") return null;
    const cards = all(".custom-switch-card")
      .filter(visible)
      .filter((node) => norm(node.textContent || "") === label);
    const controls = cards.flatMap((node) =>
      Array.from(node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')),
    );
    return controls.length === 1 ? controls[0].checked : null;
  };
  const scheduleState = rednoteSwitchState("定时发布");
  const channelOriginalInputs =
    platform === "VIDEO_WEIXINCHANNEL"
      ? all(".form-item")
          .filter(visible)
          .filter((node) => /^声明原创/.test(norm(node.textContent || "")))
          .flatMap((node) => Array.from(node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')))
          .filter(visible)
      : [];
  const originalState =
    platform === "VIDEO_WEIXINCHANNEL"
      ? channelOriginalInputs.length === 1
        ? channelOriginalInputs[0].checked
        : null
      : rednoteSwitchState("原创声明");
  const channelRadioState = (label: string): boolean | null => {
    if (platform !== "VIDEO_WEIXINCHANNEL") return null;
    const controls = all(".weui-desktop-form__check-label")
      .filter(visible)
      .filter((node) => norm(node.textContent || "") === label)
      .flatMap((node) => Array.from(node.querySelectorAll<HTMLInputElement>('input[type="radio"]')));
    return controls.length === 1 ? controls[0].checked : null;
  };
  evidence.channelImmediateSelected = channelRadioState("不定时");
  evidence.channelScheduleSelected = channelRadioState("定时");
  const douyinRadioState = (label: string): boolean | null => {
    if (platform !== "VIDEO_DOUYIN") return null;
    const labels = all('label[class*="radio-"]')
      .filter(visible)
      .filter((node) => norm(node.textContent || "") === label);
    const controls = labels.flatMap((node) =>
      Array.from(node.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')),
    );
    return controls.length === 1 ? controls[0].checked : null;
  };
  evidence.crossPostingState = douyinRadioState("同时发布到");
  evidence.crossPostingDisabled = douyinRadioState("不同时发布") === true;
  evidence.douyinImmediateSelected = douyinRadioState("立即发布");
  evidence.douyinScheduleSelected = douyinRadioState("定时发布");
  evidence.scheduleState = scheduleState;
  evidence.scheduleMatched =
    data.scheduledPublishTime === 0 &&
    (scheduleState === false ||
      (evidence.channelImmediateSelected === true && evidence.channelScheduleSelected === false) ||
      (evidence.douyinImmediateSelected === true && evidence.douyinScheduleSelected === false));
  evidence.originalState = originalState;
  evidence.originalMatched = typeof data.original === "boolean" && originalState === data.original;
  evidence.originalControlSupported = originalState !== null;
  if (mode === "inspect" || mode === "inspect_fields") {
    if (platform === "VIDEO_WEIXINCHANNEL") {
      evidence.channelOptions = all(".form-item, .weui-desktop-radio-group")
        .filter(visible)
        .filter((node) => /定时|原创|封面|可见/.test(node.textContent || ""))
        .slice(0, 15)
        .map((node) => ({
          text: norm(node.textContent || "").slice(0, 180),
          className: node.getAttribute("class") || "",
          inputs: Array.from(node.querySelectorAll<HTMLInputElement>("input")).map((input) => ({
            type: input.type,
            checked: input.checked,
            disabled: input.disabled,
            className: input.className,
          })),
        }));
      evidence.channelTopicNodes = editor
        ? Array.from(editor.querySelectorAll("*"))
            .filter((node) => /#|topic/.test((node.textContent || "") + (node.getAttribute("class") || "")))
            .slice(0, 25)
            .map((node) => ({
              tag: node.tagName,
              className: node.getAttribute("class") || "",
              text: norm(node.textContent || "").slice(0, 100),
              editable: node.getAttribute("contenteditable"),
            }))
        : [];
      evidence.surfaceControls = all("button, div, span, label, a")
        .filter(visible)
        .filter((node) => node.children.length === 0)
        .filter((node) =>
          /^(确定|确认|取消|保存|保存草稿|存草稿|返回|发表|上传封面|裁剪封面图|从视频中选择封面|原创声明|声明原创|定时|立即发表|定时发表)$/.test(
            norm(node.textContent || ""),
          ),
        )
        .slice(0, 35)
        .map((node) => ({
          tag: node.tagName,
          text: norm(node.textContent || ""),
          className: node.getAttribute("class") || "",
          ancestors: [node.parentElement, node.parentElement?.parentElement]
            .filter(Boolean)
            .map((parent) => ({ tag: parent!.tagName, className: parent!.getAttribute("class") || "" })),
        }));
    }
    evidence.mediaChecks = {
      selectedHashes: observation?.selected || [],
      requiredHashes: required,
      pending: observation?.pending || 0,
    };
    evidence.coverControls = all('button, [role="button"]')
      .filter(visible)
      .filter((node) => /封面|编辑|裁剪|选择|确定|完成|取消|上传/.test((node.textContent || "").trim()))
      .slice(0, 18)
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute("class") || "",
        text: (node.textContent || "").trim().slice(0, 60),
      }));
    evidence.coverNodes = all('[class*="cover"], [class*="Cover"]')
      .filter(visible)
      .slice(0, 18)
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute("class") || "",
        text: (node.textContent || "").trim().slice(0, 100),
        imageCount: node.querySelectorAll("img").length,
      }));
    evidence.dialogs = all('[role="dialog"], [class*="dialog"], [class*="modal"]')
      .filter(visible)
      .slice(0, 6)
      .map((node) => ({
        className: node.getAttribute("class") || "",
        text: (node.textContent || "").trim().slice(0, 900),
      }));
    evidence.frames = all("iframe").map((node) => {
      const frame = node as HTMLIFrameElement;
      let origin = "";
      try {
        origin = new URL(frame.src, location.href).origin;
      } catch {}
      return {
        className: node.getAttribute("class") || "",
        title: frame.title,
        origin,
        visible: visible(node),
        sameOriginDocument: !!frame.contentDocument,
      };
    });
    evidence.videoNodes = all("video").map((node) => {
      const video = node as HTMLVideoElement;
      return {
        visible: visible(node),
        className: node.getAttribute("class") || "",
        hasSource: !!(video.currentSrc || video.src),
        hasPoster: !!video.poster,
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
      };
    });
    evidence.uploadIndicators = all("span, p, div")
      .filter(visible)
      .filter((node) => node.children.length === 0)
      .map((node) => (node.textContent || "").trim())
      .filter((text) => /^(上传成功|上传完成|上传中|重新上传|更换视频|替换视频|删除视频|转码中|视频处理中)/.test(text))
      .slice(0, 12);
    evidence.fileInputs = inputs.map((node) => ({
      accept: node.accept,
      className: node.getAttribute("class") || "",
      fileCount: node.files?.length || 0,
      parentClass: node.parentElement?.getAttribute("class") || "",
      parentText: (node.parentElement?.textContent || "").trim().slice(0, 180),
      parentVisible: !!node.parentElement && visible(node.parentElement),
    }));
  }

  if (mode === "configure_draft") {
    if (!data.draftOnly) return result("needs_attention", "VIDEO_STEP_NOT_SUPPORTED");
    if (platform === "VIDEO_REDNOTE") {
      const close = all(".d-modal-close")
        .filter(visible)
        .filter((n) => /原创声明须知/.test(n.closest(".d-modal")?.textContent || ""));
      if (close.length) {
        close[close.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const topics = editor
        ? Array.from(editor.querySelectorAll<HTMLElement>('.tiptap-topic[contenteditable="false"]'))
        : [];
      const names = topics.map((n) =>
        norm(n.textContent || "")
          .replace(/^#/, "")
          .replace(/\[话题\]#$/, ""),
      );
      if (
        editor &&
        topics.length &&
        norm(editor.innerText).startsWith(norm(data.content)) &&
        JSON.stringify(names) === JSON.stringify(data.tags || [])
      ) {
        const last = topics[topics.length - 1];
        const range = document.createRange();
        range.setStartAfter(last);
        range.setEnd(editor, editor.childNodes.length);
        const tail = range.toString().trim();
        if (tail) {
          editor.focus();
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand("delete");
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        }
      }
    }
    const scrollables = [
      document.scrollingElement,
      ...all("div, section, main").filter(
        (n) => n.scrollHeight > n.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(n).overflowY),
      ),
    ].filter(Boolean);
    for (const n of scrollables) n!.scrollTop = n!.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 300));
    evidence.draftOnly = true;
    return result("needs_attention", "DRAFT_OPTIONS_APPLIED");
  }
  if (mode === "inspect_fields") {
    evidence.documentContext = {
      href: location.origin + location.pathname,
      isTop: window === window.top,
      userAgent: navigator.userAgent,
    };
    evidence.shadowHosts = all("*")
      .filter((n) => shadowFor(n))
      .slice(-12)
      .map((n) => ({ tag: n.tagName, className: n.getAttribute("class"), mode: shadowFor(n)?.mode }));
    evidence.customHosts = all("*")
      .filter((n) => n.tagName.includes("-"))
      .slice(-20)
      .map((n) => ({
        tag: n.tagName,
        className: n.getAttribute("class"),
        shadow: !!n.shadowRoot,
        text: norm(n.textContent || "").slice(0, 120),
      }));
    evidence.visibleTextTail = norm(document.body?.innerText || "").slice(-2200);
    evidence.layoutActions = all(
      "[class*='footer'], [class*='Footer'], [class*='submit'], [class*='publish-btn'], [class*='bottom']",
    )
      .slice(-25)
      .map((n) => ({
        tag: n.tagName,
        className: n.getAttribute("class"),
        text: norm(n.textContent || "").slice(0, 400),
        visible: visible(n),
      }));
    evidence.rawTextTail = norm(document.body?.textContent || "").slice(-1800);
    evidence.hiddenActionCandidates = all("button, [role='button'], span, div")
      .filter(
        (n) =>
          n.children.length === 0 &&
          /^(发布|保存草稿|存草稿|暂存离开|暂存并离开|暂存|保存并离开)$/.test(norm(n.textContent || "")),
      )
      .map((n) => ({
        text: norm(n.textContent || ""),
        tag: n.tagName,
        visible: visible(n),
        ancestors: [n, n.parentElement, n.parentElement?.parentElement, n.parentElement?.parentElement?.parentElement]
          .filter(Boolean)
          .map((x) => ({
            className: x!.getAttribute("class"),
            display: getComputedStyle(x!).display,
            visibility: getComputedStyle(x!).visibility,
            height: x!.getBoundingClientRect().height,
          })),
      }));
    evidence.allButtons = all("button, [role='button'], a")
      .filter(visible)
      .map((n) => ({
        tag: n.tagName,
        text: norm(n.textContent || ""),
        label: n.getAttribute("aria-label"),
        className: n.getAttribute("class"),
      }))
      .slice(-35);
    evidence.draftControls = all("button, [role='button'], a, span, div")
      .filter(visible)
      .filter((n) => n.children.length === 0 && /草稿|暂存|保存|离开/.test(norm(n.textContent || "")))
      .slice(0, 20)
      .map((n) => ({
        tag: n.tagName,
        text: norm(n.textContent || ""),
        className: n.className,
        parentClass: n.parentElement?.className,
      }));
    evidence.editorNodes = editor
      ? Array.from(editor.querySelectorAll("*"))
          .slice(0, 50)
          .map((node) => ({
            tag: node.tagName,
            className: node.getAttribute("class") || "",
            text: (node.textContent || "").trim().slice(0, 100),
            editable: node.getAttribute("contenteditable"),
          }))
      : [];
    evidence.publishOptions = all(
      'label, [role="radio"], [role="checkbox"], input[type="checkbox"], input[type="radio"], button',
    )
      .filter(visible)
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute("class") || "",
        text: (node.textContent || node.parentElement?.textContent || "").trim().slice(0, 150),
        checked: (node as HTMLInputElement).checked ?? null,
        ariaChecked: node.getAttribute("aria-checked"),
        disabled: (node as HTMLInputElement).disabled ?? null,
      }))
      .filter((node) => /原创|立即|定时|公开|可见|话题|发布|声明/.test(node.text))
      .slice(0, 35);
    evidence.topicControls = all("button, span, div")
      .filter(visible)
      .filter(
        (node) =>
          node.children.length === 0 &&
          /^(添加话题|话题|添加声明|内容声明|作品声明|原创|立即发布|定时发布)$/.test(norm(node.textContent || "")),
      )
      .slice(0, 20)
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute("class") || "",
        text: norm(node.textContent || ""),
      }));
    evidence.optionNodes = all("span, div, label")
      .filter(visible)
      .filter(
        (node) =>
          node.children.length === 0 &&
          /^(定时发布|立即发布|立即|定时|声明原创|原创声明|添加声明|内容声明|公开|谁可以看|可见范围)$/.test(
            norm(node.textContent || ""),
          ),
      )
      .slice(0, 20)
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute("class") || "",
        text: norm(node.textContent || ""),
        parentClass: node.parentElement?.getAttribute("class") || "",
        parentText: (node.parentElement?.textContent || "").trim().slice(0, 220),
        ancestors: [node.parentElement?.parentElement, node.parentElement?.parentElement?.parentElement]
          .filter(Boolean)
          .map((parent) => ({
            className: parent!.getAttribute("class") || "",
            text: (parent!.textContent || "").trim().slice(0, 250),
            controls: Array.from(
              parent!.querySelectorAll(
                'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], [class*="switch"], [class*="Switch"]',
              ),
            )
              .slice(0, 10)
              .map((control) => ({
                tag: control.tagName,
                className: control.getAttribute("class") || "",
                role: control.getAttribute("role"),
                checked: (control as HTMLInputElement).checked ?? null,
                ariaChecked: control.getAttribute("aria-checked"),
                dataState: control.getAttribute("data-state"),
              })),
          })),
        parentRole: node.parentElement?.getAttribute("role"),
        parentAriaChecked: node.parentElement?.getAttribute("aria-checked"),
        inputs: node.parentElement
          ? Array.from(node.parentElement.querySelectorAll<HTMLInputElement>("input")).map((input) => ({
              type: input.type,
              checked: input.checked,
              value: input.type === "radio" || input.type === "checkbox" ? input.value : "",
              className: input.className,
            }))
          : [],
      }));
    return result("needs_attention", "VIDEO_OPTIONS_INSPECTED");
  }

  if (mode === "gate") {
    if (observation) return result("needs_attention", "VIDEO_UPLOAD_ALREADY_STARTED");
    if (!inputs.some((node) => !/image/i.test(node.accept))) {
      // Keep enough structural evidence to diagnose a changed upload surface
      // through the extension itself, without returning page HTML or sessions.
      evidence.uploadSurface = {
        fileInputs: inputs.map((node) => ({ accept: node.accept, visible: visible(node) })),
        buttons: all('button, [role="button"]')
          .filter(visible)
          .map((node) => norm(node.textContent || ""))
          .filter((text) => /上传|视频|发表|发布|草稿|登录/.test(text))
          .slice(0, 20),
        shadowRoots: all("*").filter((node) => node.shadowRoot).length,
        frames: all("iframe").map((node) => ({
          sameOriginDocument: !!(node as HTMLIFrameElement).contentDocument,
          visible: visible(node),
        })),
      };
      const text = document.body?.innerText || "";
      return result("needs_attention", /登录|扫码|登錄/.test(text) ? "LOGIN_REQUIRED" : "UPLOAD_PAGE_REQUIRED");
    }
    if (
      norm(title?.value || "") ||
      norm(editor?.innerText || "") ||
      previews.length ||
      inputs.some((node) => node.files?.length)
    )
      return result("needs_attention", "EDITOR_NOT_EMPTY");
    if (required.some((hash) => !hash || !/^[a-f\d]{64}$/i.test(hash)))
      return result("needs_attention", "MATERIAL_MISSING");
    observation = { selected: [], pending: 0, startedAt: Date.now() };
    save(observation);
    // Observe files chosen by the existing platform handler, even when its cover
    // dialog removes the input afterwards. Only hashes are persisted.
    const state = observation;
    const handler = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input?.type !== "file") return;
      for (const file of Array.from(input.files || [])) {
        state.pending += 1;
        save(state);
        void file
          .arrayBuffer()
          .then((raw) => crypto.subtle.digest("SHA-256", raw))
          .then((raw) => {
            const hash = Array.from(new Uint8Array(raw))
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            if (!state.selected.includes(hash)) state.selected.push(hash);
          })
          .catch(() => {
            /* An unverified file cannot produce filled. */
          })
          .finally(() => {
            state.pending -= 1;
            save(state);
          });
      }
    };
    const roots: Array<Document | ShadowRoot> = [document];
    for (const node of all("*")) if (node.shadowRoot) roots.push(node.shadowRoot);
    for (const root of roots) root.addEventListener("change", handler, true);
    evidence.startedAt = state.startedAt;
    return result("ready", "VIDEO_UPLOAD_ADMITTED");
  }

  if (!observation) return result("needs_attention", "ORIGINAL_PAGE_REQUIRED");
  evidence.startedAt = observation.startedAt;
  evidence.mediaMatched = !observation.pending && required.every((hash) => observation!.selected.includes(hash!));
  if (mode === "upload_cover" || mode === "upload_horizontal_cover") {
    const horizontal = mode === "upload_horizontal_cover";
    const fileData = horizontal ? data.horizontalCover : data.cover;
    const role = horizontal ? "horizontal" : "primary";
    if (
      (horizontal && platform !== "VIDEO_DOUYIN") ||
      (!horizontal && platform !== "VIDEO_REDNOTE") ||
      !fileData?.url ||
      !fileData.sha256 ||
      !data.video.sha256 ||
      !observation.selected.includes(data.video.sha256) ||
      !evidence.titleMatched ||
      !evidence.bodyMatched
    )
      return result("needs_attention", "PREPARED_CONTENT_CHANGED");
    if (
      observation.coverSelections?.[role] === fileData.sha256 ||
      (observation.selected.includes(fileData.sha256) && (!horizontal || fileData.sha256 !== data.cover?.sha256))
    )
      return result("needs_attention", "COVER_ALREADY_SELECTED");
    if (horizontal) {
      const label = all(
        ".dy-creator-content-modal div, .dy-creator-content-modal span, .dy-creator-content-modal p",
      ).some((node) => visible(node) && /^横封面预览/.test(norm(node.textContent || "")));
      if (!label) return result("needs_attention", "COVER_SLOT_UNVERIFIED");
    }
    const dialogs = all(horizontal ? ".dy-creator-content-modal" : ".main-cover-editor-modal")
      .filter(visible)
      .slice(-1);
    const candidates = dialogs
      .flatMap((root) => Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]')))
      .filter((input) => /image|png|jpe?g/i.test(input.accept) && !/replace/.test(input.className))
      .filter(
        (input) =>
          platform === "VIDEO_REDNOTE" ||
          (!!input.parentElement &&
            visible(input.parentElement) &&
            /点击上传文件或拖拽文件到这里/.test(input.parentElement.textContent || "")),
      );
    if (candidates.length !== 1) return result("needs_attention", "COVER_UPLOAD_INPUT_NOT_READY");
    const response = await fetch(fileData.url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return result("needs_attention", "MATERIAL_MISSING");
    const blob = await response.blob();
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== fileData.sha256) return result("needs_attention", "PREPARED_MEDIA_CHANGED");
    const file = new File([blob], fileData.name, { type: fileData.type || "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    candidates[0].files = transfer.files;
    candidates[0].dispatchEvent(new Event("change", { bubbles: true }));
    candidates[0].dispatchEvent(new Event("input", { bubbles: true }));
    const until = Date.now() + 2000;
    let latest = JSON.parse(sessionStorage.getItem(key) || "null") as Observation | null;
    while (latest?.pending && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      latest = JSON.parse(sessionStorage.getItem(key) || "null") as Observation | null;
    }
    if (latest?.pending) return result("needs_attention", "COVER_SELECTION_PENDING");
    observation = {
      ...observation,
      ...(latest || {}),
      selected: Array.from(new Set([...(observation.selected || []), ...(latest?.selected || []), hash])),
      coverSelections: { ...(observation.coverSelections || {}), ...(latest?.coverSelections || {}), [role]: hash },
      repairCoverRole: role,
    };
    save(observation);
    evidence.coverSelectedHash = hash;
    evidence.coverSelectedRole = role;
    return result("needs_attention", "COVER_FILE_SELECTED");
  }
  if (mode === "open_horizontal_cover") {
    if (platform === "VIDEO_DOUYIN") {
      const modal = all(".dy-creator-content-modal").filter(visible).at(-1);
      if (modal) {
        if (/横封面预览/.test(modal.textContent || "")) return result("needs_attention", "COVER_EDITOR_OPENED");
        const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>("button"))
          .filter(visible)
          .filter((n) => norm(n.textContent || "") === "设置横封面");
        if (buttons.length) {
          buttons[buttons.length - 1].click();
          await new Promise((resolve) => setTimeout(resolve, 500));
          return result("needs_attention", "COVER_EDITOR_OPENED");
        }
      }
    }
    if (
      platform !== "VIDEO_DOUYIN" ||
      !data.horizontalCover?.sha256 ||
      !evidence.titleMatched ||
      !evidence.bodyMatched ||
      !data.video.sha256 ||
      !observation.selected.includes(data.video.sha256)
    )
      return result("needs_attention", "PREPARED_CONTENT_CHANGED");
    const roots = all('[class*="coverControl-"]')
      .filter(visible)
      .filter((node) => /横封面/.test(node.textContent || ""));
    const controls = roots
      .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("*")))
      .filter((node) => typeof node.click === "function" && /^(编辑封面|选择封面)$/.test(norm(node.textContent || "")))
      .filter(
        (node) =>
          !Array.from(node.children).some(
            (child) =>
              typeof (child as HTMLElement).click === "function" && norm(child.textContent || "") === "编辑封面",
          ),
      );
    if (controls.length !== 1) return result("needs_attention", "COVER_CONTROL_NOT_READY");
    observation.coverBeforeEdit = coverFingerprints;
    observation.repairCoverRole = "horizontal";
    save(observation);
    controls[0].click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    evidence.coverEditorOpened = true;
    return result("needs_attention", "COVER_EDITOR_OPENED");
  }
  if (mode === "finish_cover") {
    const horizontal = observation.repairCoverRole === "horizontal";
    const fileData = horizontal ? data.horizontalCover : data.cover;
    if (
      !["VIDEO_DOUYIN", "VIDEO_REDNOTE"].includes(platform) ||
      !fileData?.sha256 ||
      !observation.selected.includes(fileData.sha256) ||
      !evidence.titleMatched ||
      !evidence.bodyMatched
    )
      return result("needs_attention", "PREPARED_MEDIA_CHANGED");
    const dialogs = all(platform === "VIDEO_DOUYIN" ? ".dy-creator-content-modal" : ".main-cover-editor-modal")
      .filter(visible)
      .slice(-1);
    const buttons = dialogs
      .flatMap((root) => Array.from(root.querySelectorAll<HTMLButtonElement>("button")))
      .filter((node) => visible(node) && /^(完成|确定)$/.test(norm(node.textContent || "")));
    if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute("aria-disabled") === "true") {
      const retry = dialogs
        .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("button, span, a, div")))
        .filter(visible)
        .filter((n) => n.children.length === 0 && norm(n.textContent || "") === "重新检测");
      if (retry.length === 1 && !observation.coverCheckRetried) {
        observation.coverCheckRetried = true;
        save(observation);
        retry[0].click();
      }
      return result("needs_attention", "COVER_CONFIRM_NOT_READY");
    }
    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    evidence.coverEditorConfirmed = true;
    return result("needs_attention", "COVER_EDITOR_CONFIRMED");
  }
  if (mode === "open_cover") {
    if (!data.cover?.sha256) return result("needs_attention", "MATERIAL_MISSING");
    const videoMatched = !!data.video.sha256 && observation.selected.includes(data.video.sha256);
    if (
      platform !== "VIDEO_REDNOTE" ||
      !evidence.titleMatched ||
      !evidence.bodyMatched ||
      !videoMatched ||
      observation.pending
    )
      return result("needs_attention", "PREPARED_CONTENT_CHANGED");
    const roots = all(".cover-plugin-preview .cover--column").filter(visible);
    const controls = roots
      .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("*")))
      .filter((node) => typeof node.click === "function" && norm(node.textContent || "") === "编辑封面")
      .filter(
        (node) =>
          !Array.from(node.children).some(
            (child) =>
              typeof (child as HTMLElement).click === "function" && norm(child.textContent || "") === "编辑封面",
          ),
      );
    evidence.coverEditCandidates = controls.map((node) => ({
      tag: node.tagName,
      className: node.getAttribute("class") || "",
      visible: visible(node),
    }));
    if (controls.length !== 1) return result("needs_attention", "COVER_CONTROL_NOT_READY");
    observation.coverBeforeEdit = coverFingerprints;
    observation.repairCoverRole = "primary";
    save(observation);
    controls[0].click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    evidence.coverEditorOpened = true;
    return result("needs_attention", "COVER_EDITOR_OPENED");
  }
  const hasCovers = required.length > 1;
  const coverEditorOpen = all(
    platform === "VIDEO_REDNOTE"
      ? ".main-cover-editor-modal"
      : platform === "VIDEO_WEIXINCHANNEL"
        ? ".edit-cover-dialog"
        : ".dy-creator-content-modal",
  ).some(visible);
  const uploadBusy =
    coverEditorOpen ||
    all('[role="progressbar"], .upload-progress, .vertical-mask-layer, [class*="coverChecking"]').some(visible);
  evidence.coverEditorOpen = coverEditorOpen;
  evidence.uploadBusy = uploadBusy;
  if (mode === "repair_title") {
    evidence.observedTitle = title?.value || "";
    if (
      platform !== "VIDEO_WEIXINCHANNEL" ||
      prepared.draftTitleRejected !== true ||
      typeof prepared.previousTitle !== "string" ||
      (norm(title?.value || "") !== norm(prepared.previousTitle) && norm(title?.value || "") !== norm(data.title)) ||
      !evidence.bodyMatched ||
      !evidence.mediaMatched ||
      uploadBusy ||
      !Array.isArray(prepared.videoSources) ||
      JSON.stringify(prepared.videoSources) !== JSON.stringify(videoFingerprints)
    )
      return result("needs_attention", "TITLE_REPAIR_NOT_ADMITTED");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!title || !setter) return result("needs_attention", "TITLE_CONTROL_NOT_READY");
    setter.call(title, data.title);
    title.dispatchEvent(new Event("input", { bubbles: true }));
    title.dispatchEvent(new Event("change", { bubbles: true }));
    if (title.value !== data.title) return result("needs_attention", "TITLE_CONTROL_NOT_READY");
    observation.draftAttempted = false;
    save(observation);
    evidence.titleRepaired = true;
    return result("needs_attention", "TITLE_REPAIRED_VERIFY");
  }
  if (
    platform === "VIDEO_WEIXINCHANNEL" &&
    (Array.from(data.title).length > 16 || !/^[\p{L}\p{N} 《》“”‘’"':：+＋?？%％℃]+$/u.test(data.title))
  )
    return result("needs_attention", "INVALID_SHORT_TITLE");
  if (!evidence.titleMatched || !evidence.bodyMatched) return result("needs_attention", "PREPARED_CONTENT_CHANGED");
  const uploadedCardReady =
    platform === "VIDEO_DOUYIN" &&
    location.pathname === "/creator-micro/content/post/video" &&
    !coverEditorOpen &&
    all("span, p, div")
      .filter(visible)
      .some((node) => node.children.length === 0 && norm(node.textContent || "") === "重新上传") &&
    observation.selected.includes(data.video.sha256 || "");
  evidence.videoReadyFromUploadCard = uploadedCardReady;
  evidence.coverQualityWarnings = coverRoots
    .map((root) => norm(root.textContent || ""))
    .filter((text) => /封面不佳/.test(text));
  if (
    !evidence.mediaMatched ||
    (!previews.length && !uploadedCardReady) ||
    (hasCovers && !coverFingerprints.length) ||
    uploadBusy
  )
    return result("needs_attention", "PREPARED_MEDIA_CHANGED");
  if (!data.draftOnly && (data.tags || []).length && evidence.nativeTopicsMatched !== true)
    return result("needs_attention", "NATIVE_TOPICS_NOT_VERIFIED");
  if (!data.draftOnly && data.scheduledPublishTime === 0 && evidence.scheduleMatched !== true)
    return result("needs_attention", "SCHEDULE_SETTING_NOT_VERIFIED");
  if (!data.draftOnly && platform === "VIDEO_DOUYIN" && evidence.crossPostingDisabled !== true)
    return result("needs_attention", "CROSSPOST_SETTING_NOT_VERIFIED");
  if (!data.draftOnly && typeof data.original === "boolean" && evidence.originalMatched !== true)
    return result("needs_attention", "ORIGINAL_SETTING_NOT_VERIFIED");
  if (data.draftOnly)
    evidence.pendingPublishSettings = [
      ...(evidence.nativeTopicsMatched !== true ? ["原生话题"] : []),
      ...(evidence.scheduleMatched !== true ? ["定时选项"] : []),
      ...(evidence.originalMatched !== true ? ["原创声明"] : []),
    ];
  if (mode === "inspect") return result("filled", data.draftOnly ? "DRAFT_FIELDS_VERIFIED" : "VIDEO_FIELDS_VERIFIED");
  if (mode === "click" && data.draftOnly) return result("needs_attention", "DRAFT_ONLY_NO_PUBLISH");
  if (mode !== "click" && mode !== "save_draft") return result("needs_attention", "VIDEO_STEP_NOT_SUPPORTED");

  if (!data.expectedAccountId) return result("needs_attention", "ACCOUNT_UNVERIFIED");
  if (observation.clickAttempted) return result("result_unconfirmed", "PUBLISH_ALREADY_ATTEMPTED");
  const sameSources = (field: string, actual: string[]) =>
    Array.isArray(prepared[field]) &&
    (prepared[field] as string[]).length === actual.length &&
    actual.every((src, i) => src === (prepared[field] as string[])[i]);
  if (
    !data.draftOnly &&
    (!sameSources("videoSources", videoFingerprints) || !sameSources("coverSources", coverFingerprints))
  )
    return result("needs_attention", "PREPARED_MEDIA_CHANGED");
  if (mode === "save_draft") {
    if (platform !== "VIDEO_WEIXINCHANNEL" && !data.draftOnly)
      return result("needs_attention", "VIDEO_STEP_NOT_SUPPORTED");
    if (observation.draftAttempted) return result("result_unconfirmed", "DRAFT_ALREADY_ATTEMPTED");
    const buttons = all("button").filter(
      (node) =>
        visible(node) && /^(保存草稿|存草稿|暂存离开|暂存并离开|暂存|保存并离开)$/.test(norm(node.textContent || "")),
    );
    const button = buttons.length === 1 ? (buttons[0] as HTMLButtonElement) : undefined;
    if (
      !button ||
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      /(?:^|\s)weui-desktop-btn_disabled(?:\s|$)/.test(button.className || "")
    )
      return result("needs_attention", "DRAFT_CONTROL_NOT_READY");
    observation.draftAttempted = true;
    save(observation);
    evidence.draftClickAttempted = true;
    const confirmed = /^(?:草稿(?:已)?保存成功|保存草稿成功|草稿已保存|已保存草稿|暂存成功|已暂存|保存成功|已保存)$/;
    const observer = new MutationObserver(() => {
      const messages = all(
        '[role="alert"], [role="status"], .weui-desktop-toast, [class*="toast"], [class*="message"], [class*="Message"]',
      ).filter(visible);
      if (messages.some((n) => confirmed.test(norm(n.textContent || "")))) {
        const current = JSON.parse(sessionStorage.getItem(key) || "null") as Observation | null;
        if (current?.draftAttempted) {
          current.draftSaveConfirmed = true;
          save(current);
        }
        observer.disconnect();
      }
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true });
    for (const node of all("*")) {
      const shadow = shadowFor(node);
      if (shadow) observer.observe(shadow, { subtree: true, childList: true, characterData: true });
    }
    setTimeout(() => observer.disconnect(), 60000);
    button.click();
    return result("clicked", "DRAFT_CLICKED_CHECK_RESULT");
  }
  // Visibility must be shown explicitly in the live editor. Never infer the
  // platform default or silently change an audience control.
  const publicSetting = all(
    '[role="radio"][aria-checked="true"], input[type="radio"]:checked, [class*="permission"], [class*="visibility"]',
  ).some(
    (node) =>
      visible(node) && /^(公开|所有人可见)$/.test(norm(node.textContent || node.parentElement?.textContent || "")),
  );
  if (!publicSetting) return result("needs_attention", "VISIBILITY_UNVERIFIED");
  const buttons = all("button").filter(
    (node) => visible(node) && /^(发表|发布)$/.test((node.textContent || "").trim()),
  );
  const button = buttons.length === 1 ? (buttons[0] as HTMLButtonElement) : undefined;
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true")
    return result("needs_attention", "PUBLISH_CONTROL_NOT_READY");
  observation.clickAttempted = true;
  save(observation); // Durable in the original tab before the public action.
  evidence.clickAttempted = true;
  button.click();
  return result("clicked", "PUBLISH_CLICKED_CHECK_RESULT");
}
