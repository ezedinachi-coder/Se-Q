/**
 * report/list.tsx  (Civil — My Reports)
 *
 * FIX #4 — VIDEO PLAYER STANDARDISATION
 *   Replaced the old Video modal with the identical component used in
 *   admin/reports.tsx:
 *     • 16:9 aspectRatio videoWrapper with absolute overlays (loading / error)
 *     • shouldPlay={false}
 *     • isLooping={false}
 *     • On finish: pauseAsync() → setPositionAsync(0)
 *     • AVPlaybackStatus typed callback
 *   All other logic (pending queue, audio player, offline retry) unchanged.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { Audio } from 'expo-av';
import { AudioManager, AudioPriority } from '../../utils/AudioManager';
import { WebView } from 'react-native-webview';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';
import {
  getQueuedReports, removeFromQueue,
  uploadQueuedReport, QueuedReport,
} from '../../utils/offlineQueue';

// ─── WebView video helper ─────────────────────────────────────────────────────
// expo-av 16 Video component crashes on RN 0.83 / SDK 55:
// ViewUtils.tryRunWithVideoViewOnUiThread → UIManager.resolveView(int) removed
// from expo-modules-core in SDK 55 → NoSuchMethodError on every status tick.
// WebView HTML5 player bypasses the native bridge completely.
// NOTE: uses string concatenation — NOT a template literal — to avoid Metro
// parser issues with nested backticks inside a template-literal return value.
const buildVideoHtml = (url: string): string => {
  const safeUrl = url.replace(/'/g, '&apos;').replace(/"/g, '&quot;');
  return (
    '<!DOCTYPE html>' +
    '<html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">' +
    '<style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'html,body{width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
    'video{width:100%;height:100%;object-fit:contain;outline:none}' +
    '#fsBtn{position:fixed;bottom:10px;right:10px;z-index:999;background:rgba(0,0,0,0.6);border:none;border-radius:6px;padding:6px 10px;cursor:pointer;color:#fff;font-size:18px;line-height:1}' +
    '</style></head><body>' +
    '<video id="v" controls playsinline preload="auto" controlsList="nodownload">' +
    '<source src="' + safeUrl + '" type="video/mp4">' +
    '</video>' +
    '<button id="fsBtn" title="Fullscreen">&#x26F6;</button>' +
    '<script>' +
    'var v=document.getElementById("v");' +
    'var b=document.getElementById("fsBtn");' +
    'function post(m){try{window.ReactNativeWebView.postMessage(m);}catch(e){}}' +
    'v.addEventListener("canplay",function(){post("ready");});' +
    'v.addEventListener("ended",function(){post("ended");});' +
    'v.addEventListener("error",function(){post("error");});' +
    'v.addEventListener("playing",function(){post("ready");});' +
    'b.addEventListener("click",function(){' +
    '  var el=document.documentElement;' +
    '  if(v.webkitEnterFullscreen){v.webkitEnterFullscreen();}' +
    '  else if(v.requestFullscreen){v.requestFullscreen();}' +
    '  else if(el.requestFullscreen){el.requestFullscreen();}' +
    '  else if(el.webkitRequestFullscreen){el.webkitRequestFullscreen();}' +
    '});' +
    'v.play().catch(function(){});' +
    '<\/script>' +
    '</body></html>'
  );
};


export default function ReportList() {
  const router = useRouter();
  const [reports,        setReports]        = useState<any[]>([]);
  const [pendingReports, setPendingReports] = useState<QueuedReport[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [retrying,       setRetrying]       = useState<string | null>(null);
  const [authToken,      setAuthToken]      = useState<string | null>(null);

  // Audio
  const [currentSound,   setCurrentSound]   = useState<Audio.Sound | null>(null);
  const [playingId,      setPlayingId]      = useState<string | null>(null);
  const [isPaused,       setIsPaused]       = useState(false);
  const [playbackPos,    setPlaybackPos]    = useState(0);
  const [audioLoadingId, setAudioLoadingId] = useState<string | null>(null);

  // ── Standardised video player state (mirrors admin/reports.tsx) ────────
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [videoStatus,   setVideoStatus]   = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // videoRef removed — expo-av Video replaced with WebView (NoSuchMethodError fix)

  useFocusEffect(
    useCallback(() => {
      // FIX SOUND-CLASH: request focus through AudioManager
      AudioManager.requestFocus(AudioPriority.PLAYBACK, 'report_list_audio').catch(() => {});
      loadReports();
      loadPendingReports();
      getAuthToken().then(t => setAuthToken(t));
      return () => { currentSound?.unloadAsync(); AudioManager.releaseFocus('report_list_audio').catch(() => {}); };
    }, [])
  );

  const loadReports = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      const response = await axios.get(
        `${BACKEND_URL}/api/report/my-reports?t=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' }, timeout: 15000 }
      );
      const data = Array.isArray(response.data)
        ? response.data
        : (response.data?.reports || []);
      setReports(data);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadPendingReports = async () => {
    try {
      const queued = await getQueuedReports();
      setPendingReports(queued);
    } catch (_) {}
  };

  const onRefresh = () => { setRefreshing(true); loadReports(); loadPendingReports(); };

  const retryUpload = async (pending: QueuedReport) => {
    setRetrying(pending.id);
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }
      const success = await uploadQueuedReport(pending, token);
      if (success) { Alert.alert('✅ Uploaded', 'Report uploaded successfully!'); loadReports(); }
      else Alert.alert('Upload Failed', 'Please check your connection and try again.');
      loadPendingReports();
    } catch (error: any) {
      Alert.alert('Upload Failed', error?.response?.data?.detail || 'Please try again later.');
    } finally {
      setRetrying(null);
    }
  };

  const removePendingReport = async (id: string) => {
    await removeFromQueue(id);
    loadPendingReports();
  };

  const resolveMediaUrl = (url: string): string => {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('file://') || url.startsWith('content://')) return '';
    return `${BACKEND_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // ── Audio ────────────────────────────────────────────────────────────────
  const playAudio = async (audioUrl: string, reportId: string) => {
    const resolvedUrl = resolveMediaUrl(audioUrl);
    if (!resolvedUrl) {
      Alert.alert('Not Available', 'This audio was saved before server upload was enabled and cannot be played on this device.');
      return;
    }

    if (playingId === reportId && currentSound) {
      if (isPaused) {
        await currentSound.playFromPositionAsync(playbackPos);
        setIsPaused(false);
      } else {
        const status = await currentSound.getStatusAsync();
        if (status.isLoaded) setPlaybackPos(status.positionMillis);
        await currentSound.pauseAsync();
        setIsPaused(true);
      }
      return;
    }

    if (currentSound) {
      await currentSound.unloadAsync();
      setCurrentSound(null); setPlayingId(null); setIsPaused(false); setPlaybackPos(0);
    }

    setAudioLoadingId(reportId);
    try {
      // FIX SOUND-CLASH: AudioManager already has focus from useFocusEffect;
      // this redundant mode call is removed to prevent double-setting.
      // AudioManager.requestFocus() in useFocusEffect covers this.

      const { sound } = await Audio.Sound.createAsync(
        { uri: resolvedUrl, downloadFirst: true },
        { shouldPlay: true }
      );
      setCurrentSound(sound); setPlayingId(reportId); setIsPaused(false); setPlaybackPos(0); setAudioLoadingId(null);

      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingId(null); setIsPaused(false); setPlaybackPos(0);
          sound.unloadAsync(); setCurrentSound(null);
        }
      });
    } catch (error: any) {
      setAudioLoadingId(null);
      Alert.alert('Playback Error', 'Unable to play audio: ' + error.message);
    }
  };

  const stopAudio = async () => {
    if (currentSound) {
      await currentSound.stopAsync();
      await currentSound.unloadAsync();
      setCurrentSound(null); setPlayingId(null); setIsPaused(false); setPlaybackPos(0); setAudioLoadingId(null);
    }
  };

  const formatDate = (ds: string) =>
    new Date(ds).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  // ── Pending card ─────────────────────────────────────────────────────────
  const renderPendingReport = ({ item }: { item: QueuedReport }) => (
    <View style={styles.pendingCard}>
      <View style={styles.pendingHeader}>
        <View style={styles.pendingIcon}>
          <Ionicons name={item.type === 'audio' ? 'mic' : 'cloud-offline'} size={24} color="#F59E0B" />
        </View>
        <View style={styles.pendingInfo}>
          <Text style={styles.pendingTitle}>Pending Upload — {item.type.toUpperCase()}</Text>
          <Text style={styles.pendingDate}>{formatDate(item.timestamp)}</Text>
          <Text style={styles.pendingDuration}>
            Duration: {Math.floor((item.duration_seconds || 0) / 60)}:{((item.duration_seconds || 0) % 60).toString().padStart(2, '0')}
            {item.retryCount > 0 ? `  ·  ${item.retryCount} retries` : ''}
          </Text>
          {item.caption ? <Text style={styles.pendingCaption} numberOfLines={1}>{item.caption}</Text> : null}
        </View>
      </View>
      <View style={styles.pendingActions}>
        <TouchableOpacity style={styles.retryButton} onPress={() => retryUpload(item)} disabled={retrying === item.id}>
          {retrying === item.id
            ? <ActivityIndicator color="#fff" size="small" />
            : <><Ionicons name="refresh" size={18} color="#fff" /><Text style={styles.retryButtonText}>Retry Upload</Text></>}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={() => Alert.alert('Delete?', 'This will permanently delete this report.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => removePendingReport(item.id) },
          ])}
        >
          <Ionicons name="trash" size={18} color="#EF4444" />
        </TouchableOpacity>
      </View>
    </View>
  );

  // ── Uploaded report card ─────────────────────────────────────────────────
  const renderReport = ({ item }: any) => {
    const reportId = item._id || item.id;
    const isPlaying = playingId === reportId;
    const isLoading = audioLoadingId === reportId;
    const isAudio   = item.type === 'audio';
    const isVideo   = item.type === 'video';

    return (
      <View style={styles.reportCard}>
        <View style={styles.reportHeader}>
          <View style={[styles.reportIcon, { backgroundColor: isVideo ? '#10B98120' : '#8B5CF620' }]}>
            <Ionicons name={isVideo ? 'videocam' : 'mic'} size={28} color={isVideo ? '#10B981' : '#8B5CF6'} />
          </View>
          <View style={styles.reportInfo}>
            <Text style={styles.reportType}>{item.type?.toUpperCase()} REPORT</Text>
            <Text style={styles.reportDate}>{formatDate(item.created_at)}</Text>
            {item.caption ? <Text style={styles.reportCaption} numberOfLines={2}>{item.caption}</Text> : null}
          </View>
          <View style={[styles.statusBadge, (item.file_url && !item.file_url.startsWith('file://')) ? styles.uploadedBadge : styles.pendingBadge]}>
            <Text style={[styles.statusText, (item.file_url && !item.file_url.startsWith('file://')) ? styles.uploadedText : styles.pendingText]}>
              {(item.file_url && !item.file_url.startsWith('file://')) ? 'Uploaded' : 'Pending'}
            </Text>
          </View>
        </View>

        {item.file_url && (
          <View style={styles.playbackControls}>
            {isAudio && (
              <>
                <TouchableOpacity
                  style={[styles.playButton, isPlaying && !isPaused && styles.playButtonActive, isLoading && styles.playButtonLoading]}
                  onPress={() => playAudio(item.file_url, reportId)}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <><ActivityIndicator size="small" color="#8B5CF6" /><Text style={[styles.playButtonText, styles.playButtonTextLoading]}>Loading...</Text></>
                  ) : (
                    <>
                      <Ionicons name={isPlaying ? (isPaused ? 'play' : 'pause') : 'play'} size={24} color={isPlaying && !isPaused ? '#fff' : '#8B5CF6'} />
                      <Text style={[styles.playButtonText, isPlaying && !isPaused && styles.playButtonTextActive]}>
                        {isPlaying ? (isPaused ? 'Resume' : 'Pause') : 'Play Audio'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
                {isPlaying && !isLoading && (
                  <TouchableOpacity style={styles.stopButton} onPress={stopAudio}>
                    <Ionicons name="stop" size={20} color="#EF4444" />
                  </TouchableOpacity>
                )}
              </>
            )}

            {isVideo && (
              <TouchableOpacity
                style={styles.playButton}
                onPress={() => { setVideoStatus('loading'); setSelectedVideo(item.file_url); }}
              >
                <Ionicons name="play-circle" size={24} color="#10B981" />
                <Text style={styles.playButtonText}>Watch Video</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  // ── Standardised video player (mirrors admin/reports.tsx) ────────────────
  if (selectedVideo) {
    const resolvedVideoUrl = resolveMediaUrl(selectedVideo);

    const closePlayer = () => {
      setSelectedVideo(null);
      setVideoStatus('idle');
    };

    return (
      <SafeAreaView style={[styles.container, { backgroundColor: '#000' }]}>
        <View style={styles.videoHeader}>
          <TouchableOpacity onPress={closePlayer}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.videoTitle}>Video Report</Text>
          <View style={{ width: 28 }} />
        </View>

        <View style={styles.videoScreenCenter}>
          <View style={styles.videoWrapper}>
            <WebView
              originWhitelist={['*']}
              source={{ html: buildVideoHtml(resolvedVideoUrl), baseUrl: '' }}
              style={styles.videoPlayer}
              javaScriptEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              allowsFullscreenVideo={true}
              onLoadStart={() => setVideoStatus('loading')}
              onLoadEnd={() => {/* HTML loaded; waiting for canplay postMessage */}}
              onError={() => setVideoStatus('error')}
              onMessage={(e) => {
                const msg = e.nativeEvent.data;
                if (msg === 'ready' || msg === 'ended') setVideoStatus('ready');
                if (msg === 'error') setVideoStatus('error');
              }}
            />

            {videoStatus === 'loading' && (
              <View style={styles.videoOverlay}>
                <ActivityIndicator size="large" color="#10B981" />
                <Text style={styles.videoOverlayText}>Loading video…</Text>
              </View>
            )}

            {videoStatus === 'error' && (
              <View style={styles.videoOverlay}>
                <Ionicons name="warning" size={40} color="#EF4444" />
                <Text style={styles.videoOverlayText}>Could not load video</Text>
                <TouchableOpacity
                  style={styles.videoRetryBtn}
                  onPress={() => { setVideoStatus('loading'); }}
                >
                  <Ionicons name="refresh" size={18} color="#fff" />
                  <Text style={styles.videoRetryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>My Reports ({reports.length + pendingReports.length})</Text>
        <TouchableOpacity onPress={onRefresh}>
          <Ionicons name="refresh" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      ) : (
        <FlatList
          data={[...pendingReports.map(r => ({ ...r, isPending: true })), ...reports]}
          renderItem={({ item }) => (item as any).isPending ? renderPendingReport({ item: item as QueuedReport }) : renderReport({ item })}
          keyExtractor={item => (item as any).id || (item as any)._id || String(Math.random())}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3B82F6" />}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="document-text-outline" size={80} color="#64748B" />
              <Text style={styles.emptyText}>No reports yet</Text>
              <Text style={styles.emptySubtext}>Your submitted reports will appear here</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0F172A' },
  header:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  title:              { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  loadingContainer:   { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent:        { padding: 16 },

  pendingCard:        { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: '#F59E0B' },
  pendingHeader:      { flexDirection: 'row', alignItems: 'center' },
  pendingIcon:        { width: 48, height: 48, borderRadius: 12, backgroundColor: '#F59E0B20', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  pendingInfo:        { flex: 1 },
  pendingTitle:       { fontSize: 16, fontWeight: '600', color: '#F59E0B' },
  pendingDate:        { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  pendingDuration:    { fontSize: 12, color: '#64748B', marginTop: 2 },
  pendingCaption:     { fontSize: 12, color: '#94A3B8', marginTop: 2, fontStyle: 'italic' },
  pendingActions:     { flexDirection: 'row', marginTop: 12, gap: 8 },
  retryButton:        { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#10B981', paddingVertical: 10, borderRadius: 8 },
  retryButtonText:    { color: '#fff', fontWeight: '600' },
  deleteButton:       { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', backgroundColor: '#EF444420', borderRadius: 8 },

  reportCard:         { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 12 },
  reportHeader:       { flexDirection: 'row', alignItems: 'flex-start' },
  reportIcon:         { width: 50, height: 50, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  reportInfo:         { flex: 1 },
  reportType:         { fontSize: 14, fontWeight: '700', color: '#fff', marginBottom: 2 },
  reportDate:         { fontSize: 12, color: '#64748B', marginBottom: 4 },
  reportCaption:      { fontSize: 13, color: '#94A3B8', fontStyle: 'italic' },
  statusBadge:        { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  uploadedBadge:      { backgroundColor: '#10B98120' },
  pendingBadge:       { backgroundColor: '#F59E0B20' },
  statusText:         { fontSize: 12, fontWeight: '600' },
  uploadedText:       { color: '#10B981' },
  pendingText:        { color: '#F59E0B' },

  playbackControls:   { flexDirection: 'row', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155', gap: 8, flexWrap: 'wrap' },
  playButton:         { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, backgroundColor: '#0F172A', borderRadius: 8, minWidth: 120 },
  playButtonActive:   { backgroundColor: '#8B5CF6' },
  playButtonLoading:  { backgroundColor: '#0F172A', opacity: 0.7 },
  playButtonText:     { color: '#94A3B8', fontWeight: '500' },
  playButtonTextActive:  { color: '#fff' },
  playButtonTextLoading: { color: '#8B5CF6' },
  stopButton:         { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', backgroundColor: '#EF444420', borderRadius: 8 },

  // ── Standardised video player styles (identical to admin/reports.tsx) ──
  videoHeader:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, backgroundColor: '#000' },
  videoTitle:         { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  videoScreenCenter:  { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  videoWrapper:       { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', position: 'relative' },
  videoPlayer:        { width: '100%', height: '100%' },
  videoOverlay:       { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center' },
  videoOverlayText:   { color: '#fff', fontSize: 16, marginTop: 12, fontWeight: '500' },
  videoRetryBtn:      { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#3B82F6', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, marginTop: 16 },
  videoRetryText:     { color: '#fff', fontWeight: '600' },

  emptyContainer:     { alignItems: 'center', paddingVertical: 80 },
  emptyText:          { fontSize: 18, color: '#64748B', marginTop: 16 },
  emptySubtext:       { fontSize: 14, color: '#475569', marginTop: 4 },
});
