/* Trusted classic script: this document is opaque, network-denied, and disposable. */
(() => {
  const channel = "transcript-mermaid";
  const send = value => parent.postMessage({ channel, ...value }, "*");
  const presentation = ["color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "font-family", "font-size", "font-weight", "font-style", "font-variant", "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline", "alignment-baseline", "text-decoration", "white-space", "visibility", "display", "paint-order", "marker-start", "marker-mid", "marker-end", "clip-path", "filter", "mask", "cursor", "rx", "ry"];
  const raster = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
  function localPaint(value) {
    if (!value.includes("url(")) return value;
    // Computed styles have canonical URL tokens. Only same-document fragment paint survives export.
    return value.replace(/url\(["']?([^)'"\s]+)["']?\)/g, (_, url) => {
      const hash = url.indexOf("#");
      return hash >= 0 && (url.startsWith("#") || url.slice(0, hash) === location.href.split("#")[0])
        ? `url(#${url.slice(hash + 1)})` : "none";
    });
  }
  function neoEdgeMargins(svg) {
    if (!svg.classList.contains("flowchart")) return;
    const markers = new Map([...svg.querySelectorAll("marker")].map(marker => [marker.id, marker])), moved = new Set();
    for (const edge of svg.querySelectorAll('path[data-edge][data-look="neo"].edge-pattern-solid')) {
      const dash = edge.style.strokeDasharray.trim().split(/[\s,]+/).map(Number);
      if (dash.length !== 4 || dash.some(value => !Number.isFinite(value))) continue;
      const ends = ["start", "end"].map(end => {
        const reference = edge.getAttribute(`marker-${end}`);
        if (reference == null) return { gap: 4 };
        const id = reference.match(/#([^)'"\s]+)['"]?\)$/)?.[1], marker = markers.get(id);
        const start = end === "start";
        if (!marker || !new RegExp(`-point${start ? "Start" : "End"}-margin(?:_.+)?$`).test(marker.id)
          || !moved.has(marker) && Number(marker.getAttribute("refX")) !== (start ? 1 : 11.5)) return { gap: 0 };
        return { gap: 4, marker, offset: start ? -4 : 4 };
      });
      const gap = ends[0].gap + ends[1].gap;
      if (dash[2] < gap) continue;
      for (const end of ends) if (end.marker && !moved.has(end.marker)) {
        end.marker.setAttribute("refX", String(Number(end.marker.getAttribute("refX")) + end.offset)); moved.add(end.marker);
      }
      edge.style.strokeDasharray = `0 ${dash[1] + ends[0].gap} ${dash[2] - gap} ${dash[3] + ends[1].gap}`;
    }
  }
  function portable(svg, background) {
    svg.querySelectorAll("script, iframe, object, embed, link, meta, audio, video, source, form, input, button, animate, animateMotion, animateTransform, set").forEach(node => node.remove());
    const nodes = [svg, ...svg.querySelectorAll("*")];
    // Resolve CSS before removing styles. Export contains no model stylesheets, imports, or external paint URLs.
    const resolved = nodes.map(node => {
      const computed = getComputedStyle(node);
      return presentation.map(name => [name, localPaint(computed.getPropertyValue(name))]);
    });
    nodes.forEach((node, index) => {
      for (const attribute of [...node.attributes]) {
        const name = attribute.localName.toLowerCase();
        if (name.startsWith("on") || ["style", "srcset", "class", "base", "background", "poster", "action", "formaction", "ping", "srcdoc"].includes(name)) node.removeAttributeNode(attribute);
        else if (["href", "src"].includes(name) && !attribute.value.startsWith("#") && !raster.test(attribute.value)) node.removeAttributeNode(attribute);
        else if (attribute.value.includes("url(")) node.setAttribute(attribute.name, localPaint(attribute.value));
      }
      for (const [name, value] of resolved[index]) if (value) node.style.setProperty(name, value);
    });
    svg.querySelectorAll("style").forEach(node => node.remove());
    const box = svg.viewBox.baseVal;
    const width = box.width || svg.getBoundingClientRect().width, height = box.height || svg.getBoundingClientRect().height;
    if (!(width > 0 && height > 0)) throw Error("Missing diagram dimensions");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
    svg.style.width = `${width}px`; svg.style.height = `${height}px`; svg.style.maxWidth = "none"; svg.style.maxHeight = "none";
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [name, value] of Object.entries({ x: box.x, y: box.y, width, height, fill: background })) rect.setAttribute(name, String(value));
    svg.prepend(rect);
    return { svg: new XMLSerializer().serializeToString(svg), width, height };
  }
  addEventListener("message", async function receive(event) {
    if (event.source !== parent || event.data?.channel !== channel || typeof event.data.code !== "string") return;
    removeEventListener("message", receive);
    const { code, dark, fontFamily, opaque } = event.data;
    // Resolved desktop tokens from the pinned stylesheet, including the opaque-window override.
    const background = dark ? "#181818" : "#ffffff";
    const text = dark ? "#dfdfdf" : "#1a1c1f";
    const secondary = dark ? "rgba(255, 255, 255, 0.5)" : "rgba(26, 28, 31, 0.5)";
    const primary = opaque ? (dark ? "#282828" : "#ffffff") : (dark ? "rgba(33, 33, 33, 0.96)" : "rgba(255, 255, 255, 0.7)");
    const surface = dark ? "rgba(255, 255, 255, 0.03)" : "rgba(26, 28, 31, 0.02)";
    const tertiary = dark ? "rgba(255, 255, 255, 0.05)" : "rgba(26, 28, 31, 0.05)";
    const border = dark ? "rgba(255, 255, 255, 0.16)" : "rgba(26, 28, 31, 0.12)";
    const errorBackground = "#4d100e", errorBorder = "rgba(250, 66, 62, 0.4)";
    try {
      document.body.style.setProperty("--mermaid-surface-background", background);
      document.body.style.setProperty("--radius-md", "8px");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
        deterministicIds: true, deterministicIDSeed: "codex-mermaid", htmlLabels: false,
        flowchart: { curve: "rounded", htmlLabels: false }, darkMode: dark, fontFamily,
        look: /^\s*(?:%%[^\r\n]*(?:\r?\n|$)\s*)*(?:flowchart|graph)\b/i.test(code) ? "neo" : "classic", theme: "base",
        themeCSS: ".edgeLabel .label rect { fill: var(--mermaid-surface-background); opacity: 1; } .node[data-look=\"neo\"] rect { rx: var(--radius-md); ry: var(--radius-md); }",
        themeVariables: { darkMode: dark, background, primaryColor: primary, primaryTextColor: text, primaryBorderColor: border,
          secondaryColor: surface, secondaryTextColor: secondary, secondaryBorderColor: border, tertiaryColor: tertiary, tertiaryTextColor: secondary, tertiaryBorderColor: border,
          textColor: text, titleColor: text, lineColor: secondary, mainBkg: primary, nodeBorder: border, clusterBkg: surface, clusterBorder: border,
          edgeLabelBackground: background, labelBackgroundColor: background, labelBoxBkgColor: primary, labelBoxBorderColor: border, labelTextColor: text,
          actorBorder: secondary, actorBkg: primary, actorLineColor: secondary, actorTextColor: text, activationBkgColor: surface, activationBorderColor: secondary,
          loopTextColor: text, noteBkgColor: surface, noteBorderColor: border, noteTextColor: text, sequenceNumberColor: text, signalColor: secondary, signalTextColor: text,
          relationColor: secondary, relationLabelBackground: background, relationLabelColor: text, defaultLinkColor: secondary, dropShadow: false, useGradient: false,
          ...(dark ? { activeTaskBkgColor: tertiary, activeTaskBorderColor: border, altSectionBkgColor: background,
            attributeBackgroundColorEven: surface, attributeBackgroundColorOdd: primary, branchLabelColor: text,
            critBkgColor: errorBackground, critBorderColor: errorBorder, doneTaskBkgColor: surface, doneTaskBorderColor: border,
            excludeBkgColor: tertiary, gridColor: border, radar: { axisColor: secondary, graticuleColor: border },
            taskTextClickableColor: text, taskTextColor: text, taskTextDarkColor: text, taskTextLightColor: text,
            taskTextOutsideColor: text, todayLineColor: errorBorder, vertLineColor: border } : {}) }
      });
      const result = await mermaid.render("transcript-diagram", code);
      const template = document.createElement("template"); template.innerHTML = result.svg;
      const svg = template.content.querySelector("svg");
      if (!svg) throw Error("Missing diagram");
      document.body.append(svg);
      if (dark) for (const node of svg.querySelectorAll('.node > .label-container[style*="fill"], .node > .label-container.outer-path > path[style*="fill"]')) {
        const fill = node.style.getPropertyValue("fill");
        if (CSS.supports("color", fill)) {
          if (fill.trim().toLowerCase() !== "transparent") node.style.setProperty("fill", `color-mix(in oklab, ${fill} 22%, ${background})`, "important");
          node.closest(".node")?.querySelectorAll("text, tspan").forEach(label => label.style.setProperty("fill", text, "important"));
        }
      }
      neoEdgeMargins(svg);
      send({ type: "result", diagram: portable(svg, background) });
    } catch { send({ type: "result" }); }
  });
  send({ type: "ready" });
})();
