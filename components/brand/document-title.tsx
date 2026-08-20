"use client";

import { useEffect } from "react";

export function DocumentTitle({ title }: { title: string }): null {
  useEffect(() => {
    document.title = title === "Noderaft" ? title : `${title} · Noderaft`;
  }, [title]);

  return null;
}
