import "~style.css";
import { useEffect } from "react";

const REPOSITORY_URL = "https://github.com/benjamin-qhy/qiushui-fast-publish";

function Options() {
  useEffect(() => {
    document.title = chrome.i18n.getMessage("extensionDisplayName");
  }, []);

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto flex max-w-xl flex-col gap-6 rounded-2xl border border-default-200 bg-content1 p-6 shadow-sm">
        <div className="flex items-center gap-4">
          <img src={chrome.runtime.getURL("assets/icon.png")} alt="" className="h-14 w-14 rounded-xl" />
          <div>
            <h1 className="text-2xl font-semibold">{chrome.i18n.getMessage("extensionDisplayName")}</h1>
            <p className="text-sm text-default-500">v{chrome.runtime.getManifest().version}</p>
          </div>
        </div>
        <p>{chrome.i18n.getMessage("aboutDescription")}</p>
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{chrome.i18n.getMessage("localUsageTitle")}</h2>
          <p className="text-sm leading-6 text-default-600">{chrome.i18n.getMessage("localUsageDescription")}</p>
        </section>
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-primary-600 underline">
          {chrome.i18n.getMessage("localUsageHelp")}
        </a>
      </div>
    </main>
  );
}

export default Options;
