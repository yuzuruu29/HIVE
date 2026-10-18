import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkspaceApp } from "./projects/ProjectWorkspaceApp";

const root = document.getElementById("root");
if (!root) throw new Error("HIVE desktop root element is missing.");
createRoot(root).render(<React.StrictMode><ProjectWorkspaceApp /></React.StrictMode>);
