import React from "react"
import ReactDOM from "react-dom/client"
import { registerLicense } from "@syncfusion/ej2-base"
import { App } from "./App"
import "@syncfusion/ej2-base/styles/fluent2.css"
import "@syncfusion/ej2-buttons/styles/fluent2.css"
import "@syncfusion/ej2-inputs/styles/fluent2.css"
import "@syncfusion/ej2-popups/styles/fluent2.css"
import "@syncfusion/ej2-dropdowns/styles/fluent2.css"
import "@syncfusion/ej2-lists/styles/fluent2.css"
import "@syncfusion/ej2-splitbuttons/styles/fluent2.css"
import "@syncfusion/ej2-calendars/styles/fluent2.css"
import "@syncfusion/ej2-navigations/styles/fluent2.css"
import "@syncfusion/ej2-layouts/styles/fluent2.css"
import "@syncfusion/ej2-grids/styles/fluent2.css"
import "@syncfusion/ej2-treegrid/styles/fluent2.css"
import "@syncfusion/ej2-gantt/styles/fluent2.css"
import "./styles/app.css"
import "./styles/gantt.css"

const license = import.meta.env.VITE_SYNCFUSION_LICENSE
if (license) registerLicense(license)

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
