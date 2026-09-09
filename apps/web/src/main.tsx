import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OidcAuthorizeView } from "./components/oidc/OidcAuthorizeView";
import { DeviceApproveView } from "./components/oidc/DeviceApproveView";
import "./styles/global.css";

// Real paths, not hash routes, so they're picked before the normal app mounts
// rather than being routes inside useHashRoute's tree. `/oidc/authorize` is
// where a relying party redirects the browser; `/device` is a URL a person reads
// off a television and retypes, which `…/#/device` could not be — and it is the
// `verification_uri` the device is handed, so the path is part of the protocol.
const TOP_LEVEL: Record<string, typeof App> = {
    "/oidc/authorize": OidcAuthorizeView,
    "/device": DeviceApproveView,
};
const Root = TOP_LEVEL[window.location.pathname] ?? App;

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>,
);
