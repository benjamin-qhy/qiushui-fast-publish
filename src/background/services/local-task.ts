import { ArticleWeixin } from "~sync/article/weixin";
import type { ArticleData, DynamicData, SyncData, VideoData } from "~sync/common";
import { prepareDynamicDouyin } from "~sync/dynamic/douyin-prepare";
import { prepareDynamicMaimai } from "~sync/dynamic/maimai-prepare";
import { DynamicOkjike } from "~sync/dynamic/okjike";
import { publishPreparedDynamic, verifyDouyinProfile } from "~sync/dynamic/publish-prepared";
import { type RednotePrepareResult, prepareDynamicRednote } from "~sync/dynamic/rednote-prepare";
import { type KnownEditorContent, prepareDynamicToutiao } from "~sync/dynamic/toutiao-prepare";
import { DynamicWeixin } from "~sync/dynamic/weixin";
import { prepareDynamicWeixinChannel } from "~sync/dynamic/weixinchannel-prepare";
import { prepareDynamicX } from "~sync/dynamic/x-prepare";
import { type ZsxqDynamicData, type ZsxqDynamicResult, prepareDynamicZsxq } from "~sync/dynamic/zsxq-prepare";
import { prepareVideoWeixinChannel } from "~sync/video/weixinchannel-prepare";

const ORIGIN = "http://localhost:2663";
const PREFIX = "multipost.local-task.";
const EXECUTOR_TOKEN = "multipost.local-executor-token";
const POLL_ALARM = "multipost.local-executor-poll";
let polling = false;
interface LocalReceipt {
  taskId: string;
  platform: string;
  action: string;
  status: string;
  tabId?: number;
  code?: string;
  message?: string;
  evidence?: RednotePrepareResult["evidence"] | Record<string, unknown>;
}
interface Claim {
  taskId: string;
  action: string;
  platform: string;
  data: DynamicData | ArticleData | VideoData;
  callbackToken: string;
  operation: "start" | "resume" | "publish" | "reconcile";
  sourceTaskId?: string;
  sourceTabId?: number;
  preparedEvidence?: Record<string, unknown>;
}

async function saveResult(claim: Claim, receipt: LocalReceipt) {
  const translated =
    receipt.code && receipt.status !== "filled" ? chrome.i18n.getMessage(`localTask_${receipt.code}`) : "";
  if (translated) receipt.message = translated + (receipt.message ? ` (${receipt.message})` : "");
  await chrome.storage.local.set({ [PREFIX + claim.taskId]: receipt });
  const response = await fetch(`${ORIGIN}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: claim.taskId, token: claim.callbackToken, receipt }),
  });
  if (!response.ok) throw new Error(`LOCAL_RESULT_HTTP: ${response.status}`);
}

async function loaded(tabId: number, allowInteractive = false) {
  const started = Date.now();
  const deadline = started + 45000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    if (allowInteractive && Date.now() - started > 5000) {
      try {
        const state = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.readyState,
        });
        if (["interactive", "complete"].includes(state[0]?.result || "")) return tab;
      } catch {
        // The navigation may not have committed yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("PAGE_LOAD_TIMEOUT");
}

async function execute(claim: Claim) {
  const stored = (await chrome.storage.local.get(PREFIX + claim.taskId))[PREFIX + claim.taskId] as
    | LocalReceipt
    | undefined;
  let receipt: LocalReceipt = {
    taskId: claim.taskId,
    action: claim.action,
    platform: claim.platform,
    status: "running",
  };
  try {
    if (claim.operation === "publish" || claim.operation === "reconcile") {
      if (claim.action !== "publish" || !claim.sourceTaskId || !claim.sourceTabId) {
        await saveResult(claim, { ...receipt, status: "failed", code: "INVALID_PUBLISH_SOURCE" });
        return;
      }
      const tab = await chrome.tabs.get(claim.sourceTabId);
      await chrome.tabs.update(claim.sourceTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      receipt = { ...receipt, tabId: tab.id };
      await saveResult(claim, {
        ...receipt,
        code: claim.operation === "reconcile" ? "PUBLISH_RECONCILE_STARTED" : "PUBLISH_CHECK_STARTED",
      });
      let clicked = false;
      let clickEvidence: Record<string, unknown> =
        claim.operation === "reconcile" ? (stored?.evidence as Record<string, unknown>) || {} : {};
      if (claim.operation === "publish") {
        try {
          const result = (
            await chrome.scripting.executeScript({
              target: { tabId: claim.sourceTabId },
              func: publishPreparedDynamic,
              args: [claim.platform, claim.data as DynamicData, "click", claim.preparedEvidence || {}],
            })
          )[0]?.result;
          if (!result || result.status !== "clicked") {
            await saveResult(claim, {
              ...receipt,
              status: result?.status || "result_unconfirmed",
              code: result?.code || "PUBLISH_RESULT_NOT_CONFIRMED",
              evidence: result?.evidence || {},
            });
            return;
          }
          clicked = true;
          clickEvidence = result.evidence;
        } catch (error) {
          // Navigation can destroy the injected context after the click. Never retry the click.
          clickEvidence = { clickContextError: String(error) };
        }
        await saveResult(claim, {
          ...receipt,
          code: "PUBLISH_CLICKED_CHECK_RESULT",
          evidence: { ...clickEvidence, clickedOrNavigationUnknown: !clicked },
        });
      }
      let last: Awaited<ReturnType<typeof publishPreparedDynamic>> | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          if (claim.platform === "DYNAMIC_REDNOTE") {
            const current = await chrome.tabs.get(claim.sourceTabId);
            if (
              current.url?.includes("/publish/publish?") &&
              new URL(current.url).searchParams.get("published") === "true"
            ) {
              await chrome.tabs.update(claim.sourceTabId, { url: "https://creator.xiaohongshu.com/new/note-manager" });
              await loaded(claim.sourceTabId);
            }
            if ((await chrome.tabs.get(claim.sourceTabId)).url?.includes("/new/note-manager")) {
              await chrome.scripting.executeScript({
                target: { tabId: claim.sourceTabId },
                func: () => {
                  const publishedTab = Array.from(document.querySelectorAll<HTMLElement>(".tab-item")).find(
                    (item) => item.innerText.trim() === "已发布",
                  );
                  if (publishedTab && !publishedTab.classList.contains("tab-item--active")) publishedTab.click();
                },
              });
            }
          }
          last = (
            await chrome.scripting.executeScript({
              target: { tabId: claim.sourceTabId },
              func: publishPreparedDynamic,
              args: [claim.platform, claim.data as DynamicData, "verify", claim.preparedEvidence || {}],
            })
          )[0]?.result;
          if (claim.platform === "DYNAMIC_DOUYIN" && last?.code === "MANAGER_ENTRY_FOUND_NO_ID") {
            const verificationTab = await chrome.tabs.create({
              url: "https://www.douyin.com/user/self",
              active: false,
            });
            try {
              if (!verificationTab.id) throw new Error("PROFILE_TAB_MISSING");
              await loaded(verificationTab.id);
              for (let profileAttempt = 0; profileAttempt < 12; profileAttempt += 1) {
                const profileResult = (
                  await chrome.scripting.executeScript({
                    target: { tabId: verificationTab.id },
                    func: verifyDouyinProfile,
                    args: [claim.data as DynamicData],
                  })
                )[0]?.result;
                if (profileResult?.status === "published") {
                  last = { ...profileResult, evidence: { ...last.evidence, ...profileResult.evidence } };
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            } finally {
              if (verificationTab.id) await chrome.tabs.remove(verificationTab.id).catch(() => undefined);
            }
          }
          if (last?.status === "published" || last?.status === "submitted_pending_review") break;
        } catch {
          // The original tab may be navigating; continue read-only checks.
        }
      }
      const finalReceipt: LocalReceipt = {
        ...receipt,
        status: last?.status || "result_unconfirmed",
        code: last?.code || "PUBLISH_RESULT_NOT_CONFIRMED",
        evidence: {
          ...clickEvidence,
          ...(last?.evidence || {}),
          clickAttempted: claim.operation === "publish" || clickEvidence.clickAttempted === true,
          sourceTaskId: claim.sourceTaskId,
        },
      };
      await saveResult(claim, finalReceipt);
      const publicationEvidence = finalReceipt.evidence as Record<string, unknown> | undefined;
      if (finalReceipt.status === "published" && (publicationEvidence?.workUrl || publicationEvidence?.noteId)) {
        try {
          await chrome.tabs.remove(claim.sourceTabId);
          await saveResult(claim, {
            ...finalReceipt,
            evidence: { ...(finalReceipt.evidence || {}), taskTabClosed: true },
          });
        } catch (error) {
          await saveResult(claim, {
            ...finalReceipt,
            evidence: { ...(finalReceipt.evidence || {}), taskTabClosed: false, closeError: String(error) },
          });
        }
      }
      return;
    }
    const inspectedEditors = (
      stored?.evidence as { editors?: Array<{ className?: string; outer?: string; text?: string }> } | undefined
    )?.editors;
    const weixinArticle = claim.platform === "ARTICLE_WEIXIN" && claim.action === "save_draft";
    const weixinDynamic = claim.platform === "DYNAMIC_WEIXIN" && claim.action === "save_draft";
    const weixinChannelDynamic = claim.platform === "DYNAMIC_WEIXINCHANNEL" && claim.action === "prepare";
    const douyinDynamic = claim.platform === "DYNAMIC_DOUYIN" && claim.action === "prepare";
    const toutiaoDynamic = claim.platform === "DYNAMIC_TOUTIAO" && claim.action === "prepare";
    const jikeDynamic = claim.platform === "DYNAMIC_OKJIKE" && claim.action === "prepare";
    const zsxqDynamic = claim.platform === "DYNAMIC_ZSXQ" && claim.action === "prepare";
    const maimaiDynamic = claim.platform === "DYNAMIC_MAIMAI" && claim.action === "prepare";
    const xDynamic = claim.platform === "DYNAMIC_X" && claim.action === "prepare";
    const weixinVideo = claim.platform === "VIDEO_WEIXINCHANNEL" && claim.action === "prepare";
    if (
      !weixinArticle &&
      !weixinDynamic &&
      !weixinChannelDynamic &&
      !douyinDynamic &&
      !toutiaoDynamic &&
      !jikeDynamic &&
      !zsxqDynamic &&
      !maimaiDynamic &&
      !xDynamic &&
      !weixinVideo &&
      (claim.action !== "prepare" || claim.platform !== "DYNAMIC_REDNOTE")
    ) {
      await saveResult(claim, { ...receipt, status: "unverified", code: "ACTION_NOT_VERIFIED" });
      return;
    }
    if ((weixinArticle || weixinDynamic) && claim.operation !== "start") {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (weixinVideo && claim.operation !== "start") {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (
      zsxqDynamic &&
      claim.operation !== "start" &&
      ![
        "SPHERE_INSPECTION_REQUIRED",
        "EDITOR_INSPECTION_REQUIRED",
        "EDITOR_NOT_READY",
        "UPLOAD_INSPECTION_REQUIRED",
        "FIELDS_NOT_VERIFIED",
        "EDITOR_NOT_EMPTY",
        "RECONCILE_REQUIRED",
      ].includes(stored?.code || "")
    ) {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (
      maimaiDynamic &&
      claim.operation !== "start" &&
      !["EDITOR_NOT_READY", "UPLOAD_UNCONFIRMED", "RECONCILE_REQUIRED"].includes(stored?.code || "")
    ) {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (
      xDynamic &&
      claim.operation !== "start" &&
      ![
        "EDITOR_INSPECTION_REQUIRED",
        "UPLOAD_INSPECTION_REQUIRED",
        "FIELDS_NOT_VERIFIED",
        "RECONCILE_REQUIRED",
      ].includes(stored?.code || "")
    ) {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (
      weixinChannelDynamic &&
      claim.operation === "resume" &&
      !["LOGIN_REQUIRED", "UPLOAD_PAGE_REQUIRED"].includes(stored?.code || "")
    ) {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (
      (douyinDynamic || toutiaoDynamic || jikeDynamic) &&
      claim.operation !== "start" &&
      !(stored?.code === "EXECUTION_ERROR" && stored?.message?.includes("PAGE_LOAD_TIMEOUT")) &&
      !(douyinDynamic && ["EDITOR_NOT_EMPTY", "RECONCILE_REQUIRED"].includes(stored?.code || "")) &&
      !(
        toutiaoDynamic && ["EDITOR_NOT_EMPTY", "UPLOAD_UNCONFIRMED", "FIELDS_NOT_VERIFIED"].includes(stored?.code || "")
      ) &&
      !(
        toutiaoDynamic &&
        Boolean((claim.data as DynamicData & { replaceExisting?: KnownEditorContent }).replaceExisting) &&
        stored?.code === "RECONCILE_REQUIRED"
      ) &&
      !(
        toutiaoDynamic &&
        stored?.code === "RECONCILE_REQUIRED" &&
        inspectedEditors?.length === 1 &&
        inspectedEditors[0]?.className === "ProseMirror" &&
        (stored.evidence as { dialogs?: Array<{ text?: string }> } | undefined)?.dialogs?.some((dialog) =>
          dialog.text?.includes("已上传 1 张图片"),
        )
      ) &&
      !(
        toutiaoDynamic &&
        stored?.code === "RECONCILE_REQUIRED" &&
        (stored.evidence as { dialogs?: Array<{ text?: string }> } | undefined)?.dialogs?.some((dialog) =>
          /共\s*1\s*张[，,]\s*还能上传/.test(dialog.text || ""),
        )
      ) &&
      !(
        toutiaoDynamic &&
        stored?.code === "RECONCILE_REQUIRED" &&
        inspectedEditors?.length === 1 &&
        inspectedEditors[0]?.className === "ProseMirror" &&
        inspectedEditors[0]?.outer?.includes('class="syl-placeholder ProseMirror-widget"')
      )
    ) {
      await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
      return;
    }
    if (claim.operation === "resume" && !stored?.tabId) {
      await saveResult(claim, {
        ...receipt,
        status: "needs_attention",
        code: "ORIGINAL_PAGE_REQUIRED",
      });
      return;
    }
    const tab =
      claim.operation === "resume"
        ? await chrome.tabs.get(stored!.tabId!)
        : await chrome.tabs.create({
            url:
              weixinArticle || weixinDynamic
                ? "https://mp.weixin.qq.com/"
                : weixinChannelDynamic
                  ? "https://channels.weixin.qq.com/platform/post/finderNewLifeCreate"
                  : weixinVideo
                    ? "https://channels.weixin.qq.com/platform/post/create"
                    : douyinDynamic
                      ? "https://creator.douyin.com/creator-micro/content/upload?default-tab=3"
                      : toutiaoDynamic
                        ? "https://mp.toutiao.com/profile_v4/weitoutiao/publish"
                        : jikeDynamic
                          ? "https://web.okjike.com/"
                          : zsxqDynamic
                            ? "https://wx.zsxq.com/"
                            : maimaiDynamic
                              ? "https://maimai.cn/community/home/following"
                              : xDynamic
                                ? "https://x.com/home"
                                : "https://creator.xiaohongshu.com/publish/publish?target=image",
            active: true,
          });
    if (!tab.id) throw new Error("TAB_CREATE_FAILED");
    receipt = { ...receipt, tabId: tab.id };
    await saveResult(claim, receipt);
    const readyTab = await loaded(
      tab.id,
      douyinDynamic || toutiaoDynamic || jikeDynamic || zsxqDynamic || maimaiDynamic || xDynamic,
    );
    if (
      new URL(readyTab.url || "").origin !==
      (weixinArticle || weixinDynamic
        ? "https://mp.weixin.qq.com"
        : weixinVideo || weixinChannelDynamic
          ? "https://channels.weixin.qq.com"
          : douyinDynamic
            ? "https://creator.douyin.com"
            : toutiaoDynamic
              ? "https://mp.toutiao.com"
              : jikeDynamic
                ? "https://web.okjike.com"
                : zsxqDynamic
                  ? "https://wx.zsxq.com"
                  : maimaiDynamic
                    ? "https://maimai.cn"
                    : xDynamic
                      ? "https://x.com"
                      : "https://creator.xiaohongshu.com")
    ) {
      await saveResult(claim, {
        ...receipt,
        status: "needs_attention",
        code: "PLATFORM_ORIGIN_CHANGED",
      });
      return;
    }
    if (weixinVideo) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: prepareVideoWeixinChannel,
        args: [claim.data as VideoData],
      });
      const result = results[0]?.result;
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (weixinChannelDynamic) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: prepareDynamicWeixinChannel,
        args: [claim.data as DynamicData],
      });
      const result = results[0]?.result;
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (douyinDynamic) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: prepareDynamicDouyin,
        args: [
          claim.data as DynamicData,
          claim.operation === "resume" && stored?.code === "EDITOR_NOT_EMPTY"
            ? "inspect"
            : claim.operation === "resume" && stored?.code === "RECONCILE_REQUIRED"
              ? "finish_text"
              : "start",
        ],
      });
      const result = results[0]?.result;
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (toutiaoDynamic) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: prepareDynamicToutiao,
        args: [
          claim.data as DynamicData & { replaceExisting?: KnownEditorContent },
          claim.operation === "resume" &&
          (claim.data as DynamicData & { replaceExisting?: KnownEditorContent }).replaceExisting
            ? "replace_known"
            : claim.operation === "resume" && (claim.data as DynamicData).textOnly
              ? "inspect"
              : claim.operation === "resume" &&
                  ["EDITOR_NOT_EMPTY", "UPLOAD_UNCONFIRMED", "FIELDS_NOT_VERIFIED"].includes(stored?.code || "")
                ? "inspect"
                : claim.operation === "resume" &&
                    stored?.code === "RECONCILE_REQUIRED" &&
                    (stored.evidence as { dialogs?: Array<{ text?: string }> } | undefined)?.dialogs?.some((dialog) =>
                      dialog.text?.includes("已上传 1 张图片"),
                    )
                  ? "finish_upload"
                  : claim.operation === "resume" &&
                      stored?.code === "RECONCILE_REQUIRED" &&
                      inspectedEditors?.[0]?.outer?.includes('class="syl-placeholder ProseMirror-widget"')
                    ? "start"
                    : claim.operation === "resume" && stored?.code === "RECONCILE_REQUIRED"
                      ? "verify"
                      : "start",
        ],
      });
      const result = results[0]?.result;
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (jikeDynamic) {
      const syncData: SyncData = {
        platforms: [{ name: "DYNAMIC_OKJIKE" }],
        isAutoPublish: false,
        data: claim.data as DynamicData,
      };
      const result = (
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: DynamicOkjike,
          args: [syncData, true],
        })
      )[0]?.result;
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (zsxqDynamic) {
      const runZsxq = async (mode: "inspect" | "open_editor" | "fill" | "inspect_upload" | "replace_known") =>
        (
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: prepareDynamicZsxq,
            args: [claim.data as ZsxqDynamicData, mode],
          })
        )[0]?.result as ZsxqDynamicResult | undefined;
      let result: ZsxqDynamicResult | undefined;
      if (claim.operation === "start") {
        const inspected = await runZsxq("inspect");
        const target = (claim.data as ZsxqDynamicData).targetSphere.trim();
        const links =
          (inspected?.evidence as { anchors?: Array<{ text: string; href: string }> } | undefined)?.anchors || [];
        const exact = links.filter((link) => link.text.trim() === target);
        if (exact.length !== 1) {
          result = { status: "needs_attention", code: "TARGET_SPHERE_UNCONFIRMED", evidence: inspected?.evidence };
        } else {
          const destination = new URL(exact[0].href);
          if (destination.origin !== "https://wx.zsxq.com" || !/^\/group\/\d+$/.test(destination.pathname)) {
            result = {
              status: "needs_attention",
              code: "TARGET_SPHERE_UNCONFIRMED",
              evidence: { targetSphere: target },
            };
          } else {
            if (new URL((await chrome.tabs.get(tab.id)).url || "").pathname !== destination.pathname) {
              await chrome.tabs.update(tab.id, { url: destination.href });
              await loaded(tab.id, true);
            }
            const opened = await runZsxq("open_editor");
            result = opened?.code === "EDITOR_INSPECTION_REQUIRED" ? await runZsxq("fill") : opened;
          }
        }
      } else {
        result = await runZsxq(
          (claim.data as ZsxqDynamicData).replaceExisting
            ? "replace_known"
            : ["SPHERE_INSPECTION_REQUIRED", "EDITOR_NOT_READY"].includes(stored?.code || "")
              ? "open_editor"
              : stored?.code === "EDITOR_INSPECTION_REQUIRED"
                ? "fill"
                : "inspect_upload",
        );
      }
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (maimaiDynamic) {
      const result = (
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: prepareDynamicMaimai,
          args: [
            claim.data as DynamicData,
            claim.operation === "resume" && stored?.code === "UPLOAD_UNCONFIRMED"
              ? "inspect"
              : claim.operation === "resume" && stored?.code === "RECONCILE_REQUIRED"
                ? "verify"
                : "start",
          ],
        })
      )[0]?.result;
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (xDynamic) {
      const runX = async (mode: "inspect" | "fill" | "inspect_upload" | "verify") =>
        (
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: prepareDynamicX,
            args: [claim.data as DynamicData, mode],
          })
        )[0]?.result;
      const result =
        claim.operation === "start"
          ? await (async () => {
              const inspected = await runX("inspect");
              return inspected?.code === "EDITOR_INSPECTION_REQUIRED" ? await runX("fill") : inspected;
            })()
          : await runX(
              stored?.code === "EDITOR_INSPECTION_REQUIRED"
                ? "fill"
                : stored?.code === "RECONCILE_REQUIRED"
                  ? "verify"
                  : "inspect_upload",
            );
      await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
      return;
    }
    if (weixinDynamic) {
      const syncData: SyncData = {
        platforms: [{ name: "DYNAMIC_WEIXIN" }],
        isAutoPublish: false,
        data: claim.data as DynamicData,
      };
      const draft = (
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: DynamicWeixin,
          args: [syncData, true],
        })
      )[0]?.result as
        | {
            appMsgId?: string;
            editUrl?: string;
            title?: string;
            content?: string;
            imageCount?: number;
            account?: string;
          }
        | undefined;
      if (
        !draft?.appMsgId ||
        !draft.editUrl ||
        new URL(draft.editUrl).origin !== "https://mp.weixin.qq.com" ||
        draft.title !== (claim.data as DynamicData).title ||
        draft.imageCount !== (claim.data as DynamicData).images.length
      ) {
        await saveResult(claim, {
          ...receipt,
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
          evidence: draft,
        });
        return;
      }
      await chrome.tabs.update(tab.id, { url: draft.editUrl });
      const editTab = await loaded(tab.id);
      if (!editTab.url?.includes(`appmsgid=${encodeURIComponent(draft.appMsgId)}`)) {
        await saveResult(claim, {
          ...receipt,
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
          evidence: { appMsgId: draft.appMsgId, editUrl: draft.editUrl },
        });
        return;
      }
      await saveResult(claim, {
        ...receipt,
        status: "draft_saved",
        code: "DRAFT_ID_CONFIRMED",
        evidence: {
          appMsgId: draft.appMsgId,
          editUrl: draft.editUrl,
          title: draft.title,
          content: draft.content,
          imageCount: draft.imageCount,
          account: draft.account,
        },
      });
      return;
    }
    if (weixinArticle) {
      const syncData: SyncData = {
        platforms: [{ name: "ARTICLE_WEIXIN" }],
        isAutoPublish: false,
        data: claim.data as ArticleData,
      };
      const draft = (
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: ArticleWeixin,
          args: [syncData, true],
        })
      )[0]?.result as { appMsgId?: string; editUrl?: string; title?: string } | undefined;
      if (!draft?.appMsgId || !draft.editUrl || new URL(draft.editUrl).origin !== "https://mp.weixin.qq.com") {
        await saveResult(claim, { ...receipt, status: "result_unconfirmed", code: "RECONCILE_REQUIRED" });
        return;
      }
      await chrome.tabs.update(tab.id, { url: draft.editUrl });
      const editTab = await loaded(tab.id);
      if (!editTab.url?.includes(`appmsgid=${encodeURIComponent(draft.appMsgId)}`)) {
        await saveResult(claim, {
          ...receipt,
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
          evidence: { appMsgId: draft.appMsgId },
        });
        return;
      }
      await saveResult(claim, {
        ...receipt,
        status: "draft_saved",
        code: "DRAFT_ID_CONFIRMED",
        evidence: { appMsgId: draft.appMsgId, title: draft.title },
      });
      return;
    }
    // Only a pre-upload login pause permits a new upload when continuing.
    const inspectOnly =
      claim.operation === "resume" && stored?.code !== "LOGIN_REQUIRED" && stored?.code !== "UPLOAD_PAGE_REQUIRED";
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: prepareDynamicRednote,
      args: [claim.data as DynamicData, inspectOnly, inspectOnly],
    });
    const result = results[0]?.result;
    await saveResult(claim, { ...receipt, ...(result || { status: "result_unconfirmed", code: "MISSING_RESULT" }) });
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    const loginRequired =
      ["ARTICLE_WEIXIN", "DYNAMIC_WEIXIN"].includes(claim.platform) && /重新登录|无法获取.token|登录/.test(detail);
    const failed = {
      ...receipt,
      status: loginRequired ? "needs_attention" : receipt.tabId ? "result_unconfirmed" : "failed",
      code: loginRequired ? "LOGIN_REQUIRED" : "EXECUTION_ERROR",
      message: detail,
    };
    try {
      await saveResult(claim, failed);
    } catch {
      await chrome.storage.local.set({ [PREFIX + claim.taskId]: failed });
    }
  }
}

async function pollLocalTasks() {
  if (polling) return;
  polling = true;
  try {
    const token = (await chrome.storage.local.get(EXECUTOR_TOKEN))[EXECUTOR_TOKEN];
    if (typeof token !== "string") return;
    const response = await fetch(`${ORIGIN}/next`, {
      headers: { Authorization: `Bearer ${token}`, "X-MultiPost-Extension-Id": chrome.runtime.id },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`LOCAL_POLL_HTTP: ${response.status}`);
    await execute((await response.json()) as Claim);
  } catch (error) {
    console.debug("FastPublish local executor unavailable:", String(error));
  } finally {
    polling = false;
  }
}

export function setupLocalExecutor() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) void pollLocalTasks();
  });
  // Alarms wake the MV3 worker even when there is no publishing/bridge tab.
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  void pollLocalTasks();
}

export function localTaskMessageHandler(
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: unknown) => void,
): boolean {
  const message = request as { action?: string; data?: { taskId?: string; token?: string } };
  if (
    !["MULTIPOST_EXTENSION_LOCAL_STATUS", "MULTIPOST_EXTENSION_LOCAL_TASK", "MULTIPOST_EXTENSION_LOCAL_PAIR"].includes(
      message?.action || "",
    )
  )
    return false;
  let origin = "";
  try {
    origin = new URL(sender.url || "").origin;
  } catch {
    /* denied below */
  }
  if (origin !== ORIGIN || sender.frameId !== 0 || sender.id !== chrome.runtime.id) {
    sendResponse({ error: "LOCAL_ORIGIN_REQUIRED" });
    return true;
  }
  if (message.action === "MULTIPOST_EXTENSION_LOCAL_STATUS") {
    sendResponse({
      extensionId: chrome.runtime.id,
      protocol: 2,
      capabilities: [
        { platform: "DYNAMIC_REDNOTE", action: "prepare" },
        { platform: "ARTICLE_WEIXIN", action: "save_draft" },
        { platform: "DYNAMIC_WEIXIN", action: "save_draft" },
        { platform: "DYNAMIC_WEIXINCHANNEL", action: "prepare" },
        { platform: "DYNAMIC_DOUYIN", action: "prepare" },
        { platform: "DYNAMIC_TOUTIAO", action: "prepare" },
        { platform: "DYNAMIC_OKJIKE", action: "prepare" },
        { platform: "VIDEO_WEIXINCHANNEL", action: "prepare" },
      ],
    });
    return true;
  }
  if (message.action === "MULTIPOST_EXTENSION_LOCAL_PAIR") {
    (async () => {
      try {
        const response = await fetch(`${ORIGIN}/pair-claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: message.data?.token, extensionId: chrome.runtime.id }),
        });
        if (!response.ok) throw new Error(`LOCAL_PAIR_HTTP: ${response.status}`);
        const result = (await response.json()) as { executorToken: string };
        await chrome.storage.local.set({ [EXECUTOR_TOKEN]: result.executorToken });
        sendResponse({ paired: true, extensionId: chrome.runtime.id });
        void pollLocalTasks();
      } catch (error) {
        sendResponse({ error: String(error) });
      }
    })();
    return true;
  }
  (async () => {
    try {
      const response = await fetch(`${ORIGIN}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.data),
      });
      if (!response.ok) throw new Error(`LOCAL_CLAIM_HTTP: ${response.status}`);
      const claim = (await response.json()) as Claim;
      sendResponse({ accepted: true, taskId: claim.taskId });
      await execute(claim);
    } catch (error) {
      sendResponse({ error: String(error instanceof Error ? error.message : error) });
    }
  })();
  return true;
}
