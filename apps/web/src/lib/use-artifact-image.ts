import { useEffect, useState } from "react";
import type { ArtifactTarget } from "./artifact-open";
import { decodeArtifactBase64 } from "./artifact-open";
import type { RpcClient } from "./rpc";
import { useSpaceRpc } from "./space-rpc";

type ImageDownload = {
  promise: Promise<string>;
  consumers: number;
  objectUrl: string | null;
  settled: boolean;
};

const scopedDownloads = new WeakMap<RpcClient, Map<string, ImageDownload>>();

function releaseUnusedDownload(
  downloads: Map<string, ImageDownload>,
  key: string,
  download: ImageDownload,
) {
  // Keep pending work reusable even if its original consumers leave.
  if (download.consumers || !download.settled) return;
  if (download.objectUrl) URL.revokeObjectURL(download.objectUrl);
  if (downloads.get(key) === download) downloads.delete(key);
}

function acquireDownload(client: RpcClient, target: ArtifactTarget, artifactId: string) {
  let downloads = scopedDownloads.get(client);
  if (!downloads) {
    downloads = new Map();
    scopedDownloads.set(client, downloads);
  }
  const cache = downloads;
  const key = JSON.stringify([
    "botId" in target ? "bot" : "group",
    "botId" in target ? target.botId : target.groupId,
    artifactId,
  ]);
  let download = cache.get(key);
  if (!download) {
    const entry: ImageDownload = {
      consumers: 0,
      objectUrl: null,
      settled: false,
      promise: client.artifacts
        .get({ ...target, artifactId })
        .then((artifact) => {
          const bytes = decodeArtifactBase64(artifact.contentBase64);
          entry.objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }),
          );
          return entry.objectUrl;
        })
        .catch((error) => {
          if (cache.get(key) === entry) cache.delete(key);
          throw error;
        })
        .finally(() => {
          entry.settled = true;
          releaseUnusedDownload(cache, key, entry);
        }),
    };
    download = entry;
    cache.set(key, download);
  }
  download.consumers++;
  const entry = download;
  return {
    promise: entry.promise,
    release: () => {
      entry.consumers--;
      releaseUnusedDownload(cache, key, entry);
    },
  };
}

export function useArtifactImage(
  target: ArtifactTarget | undefined,
  artifactId: string,
  enabled = true,
) {
  const [src, setSrc] = useState<string | null>(null);
  const rpc = useSpaceRpc();
  const botId = target && "botId" in target ? target.botId : undefined;
  const groupId = target && "groupId" in target ? target.groupId : undefined;
  useEffect(() => {
    setSrc(null);
    if (!enabled || (!botId && !groupId)) return;
    let cancelled = false;
    const download = acquireDownload(rpc, botId ? { botId } : { groupId: groupId! }, artifactId);
    void download.promise
      .then((objectUrl) => {
        if (!cancelled) setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      download.release();
    };
  }, [rpc, artifactId, botId, groupId, enabled]);
  return src;
}
