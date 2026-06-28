import React from "react";
import { createRoot } from "react-dom/client";
import { WrappedApp } from "./App";
import "./app.css";

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Missing #app root element");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <WrappedApp />
  </React.StrictMode>
);
