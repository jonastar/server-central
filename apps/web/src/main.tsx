import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OidcAuthorizeView } from "./components/oidc/OidcAuthorizeView";
import "./styles.css";

// A relying party redirects the browser straight to this path (a real navigation,
// not hash routing), so it's picked before the normal app mounts rather than
// being a route inside useHashRoute's tree.
const Root = window.location.pathname === "/oidc/authorize" ? OidcAuthorizeView : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>,
);
