import { Image } from "@heroui/react";
import type React from "react";

const Header: React.FC = () => {
  return (
    <header className="bg-white shadow-sm">
      <div className="flex justify-between items-center px-4 py-2">
        <div className="flex items-center">
          <Image src={chrome.runtime.getURL("assets/icon.png")} alt="logo" className="mr-2 w-8 h-8 rounded-full" />
          <h1 className="text-lg font-semibold">{chrome.i18n.getMessage("extensionDisplayName")}</h1>
        </div>
      </div>
    </header>
  );
};

export default Header;
