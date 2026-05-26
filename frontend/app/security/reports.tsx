/**
 * security/reports.tsx
 *
 * FIX #4 — VIDEO PLAYER STANDARDISATION
 *   Replaced the old full-screen Video modal with the identical component used
 *   in admin/reports.tsx:
 *     • 16:9 aspectRatio videoWrapper with absolute overlays (loading / error)
 *     • shouldPlay={false}  — user must explicitly press play
 *     • isLooping={false}
 *     • On finish: pauseAsync() → setPositionAsync(0)  (prevents the infinite
 *       auto-resume loop that occurred with setPositionAsync alone)
 *     • AVPlaybackStatus type for onPlaybackStatusUpdate
 *     • Auth Bearer header passed via source.headers for protected Cloudinary URLs
 *   The full-screen modal chrome (header row, black background) is kept because
 *   security officers need to focus on the video without distractions.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, Alert, RefreshControl, Linking, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { Audio } from 'expo-av';
import { AudioManager, AudioPriority } from '../../utils/AudioManager';
import { WebView } from 'react-native-webview';
import { getAuthToken, clearAuthData, getUserMetadata } from '../../utils/auth';
import { LocationMapModal } from '../../components/LocationMapModal';
import BACKEND_URL from '../../utils/config';

// ─── WebView video helper ─────────────────────────────────────────────────────
// expo-av 16 Video component crashes on RN 0.83 / SDK 55:
// ViewUtils.tryRunWithVideoViewOnUiThread → UIManager.resolveView(int) removed
// from expo-modules-core in SDK 55 → NoSuchMethodError on every status tick.
// WebView HTML5 player bypasses the native bridge completely.
// NOTE: uses string concatenation — NOT a template literal — to avoid Metro
// parser issues with nested backticks inside a template-literal return value.
// allowDownload=false → security dashboard (no download); true → admin
const buildVideoHtml = (url: string, allowDownload: boolean = false): string => {
  const safeUrl = url.replace(/'/g, '&apos;').replace(/"/g, '&quot;');
  const controlsList = allowDownload ? '' : 'controlsList="nodownload"';
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
    '<video id="v" controls playsinline preload="auto" ' + controlsList + '>' +
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



export default function SecurityReports() {
  const router = useRouter();
  const [reports,        setReports]        = useState<any[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [currentSound,   setCurrentSound]   = useState<Audio.Sound | null>(null);
  const [playingId,      setPlayingId]      = useState<string | null>(null);
  const [isPaused,       setIsPaused]       = useState(false);
  const [playbackPos,    setPlaybackPos]    = useState(0);
  const [audioLoadingId, setAudioLoadingId] = useState<string | null>(null);
  const [userRole,       setUserRole]       = useState<string>('security');
  const [authToken,      setAuthToken]      = useState<string | null>(null);
  const [locationModal,  setLocationModal]  = useState<{
    visible: boolean; lat: number; lng: number; title: string;
  } | null>(null);

  // ── Standardised video player state (mirrors admin/reports.tsx) ──────────
  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string | null>(null);
  const [videoStatus,      setVideoStatus]      = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // videoRef removed — expo-av Video replaced with WebView (NoSuchMethodError fix)

  useFocusEffect(
    useCallback(() => {
      loadReports();
      getAuthToken().then(t => setAuthToken(t));
      return () => { currentSound?.unloadAsync(); };
    }, [])
  );

  useEffect(() => {
    checkUserRole();
    const interval = setInterval(loadReports, 30000);
    return () => {
      clearInterval(interval);
      currentSound?.unloadAsync();
    };
  }, []);

  const checkUserRole = async () => {
    const metadata = await getUserMetadata();
    setUserRole(metadata.role || 'security');
  };

  const loadReports = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      const response = await axios.get(
        `${BACKEND_URL}/api/security/nearby-reports?t=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' }, timeout: 15000 }
      );
      setReports(response.data || []);
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

  const onRefresh = () => { setRefreshing(true); loadReports(); };

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
      Alert.alert('Not Available', 'This audio was recorded before server upload was enabled and cannot be played back remotely.');
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
      await currentSound.stopAsync();
      await currentSound.unloadAsync();
      setCurrentSound(null);
      setPlayingId(null);
      setIsPaused(false);
      setPlaybackPos(0);
    }

    setAudioLoadingId(reportId);
    try {
      // FIX SOUND-CLASH: request focus through AudioManager so the singleton
      // tracks this mode change and can restore it correctly on logout/role-switch.
      await AudioManager.requestFocus(AudioPriority.PLAYBACK, 'security_reports_audio');
      const { sound } = await Audio.Sound.createAsync(
        { uri: resolvedUrl, downloadFirst: true },
        { shouldPlay: true }
      );
      setCurrentSound(sound);
      setPlayingId(reportId);
      setIsPaused(false);
      setPlaybackPos(0);
      setAudioLoadingId(null);

      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingId(null); setIsPaused(false); setPlaybackPos(0);
          sound.unloadAsync(); setCurrentSound(null);
        }
      });
    } catch (error: any) {
      setAudioLoadingId(null);
      Alert.alert('Playback Error', 'Unable to play audio file. ' + error.message);
    }
  };

  const stopAudio = async () => {
    if (currentSound) {
      await currentSound.stopAsync();
      await currentSound.unloadAsync();
      setCurrentSound(null); setPlayingId(null);
      setIsPaused(false); setPlaybackPos(0); setAudioLoadingId(null);
    }
  };

  // ── Video — open player ──────────────────────────────────────────────────
  const openVideo = (videoUrl: string) => {
    setVideoStatus('loading');
    setSelectedVideoUrl(videoUrl);
  };

  const getSenderDisplay = (item: any) => {
    if (item.is_anonymous) {
      if (userRole === 'admin') {
        return {
          name: item.sender_name || item.full_name || item.sender_email || item.user_email || 'Unknown',
          label: '(Anonymous - for discreet attendance)',
        };
      }
      return { name: 'Anonymous', label: '' };
    }
    return {
      name: item.sender_name || item.full_name || item.sender_email || item.user_email || 'Unknown User',
      label: '',
    };
  };

  const formatDate = (ds: string) =>
    new Date(ds).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  const renderReport = ({ item }: any) => {
    const sender   = getSenderDisplay(item);
    const reportId = item._id || item.id;
    const isPlaying = playingId === reportId;
    const isLoading = audioLoadingId === reportId;

    return (
      <View style={styles.reportCard}>
        <View style={styles.reportHeader}>
          <View style={styles.reportIcon}>
            {item.user_photo_url ? (
              <Image source={{ uri: item.user_photo_url }} style={styles.reportUserAvatar} />
            ) : (
              <Ionicons
                name={item.type === 'video' ? 'videocam' : 'mic'}
                size={28}
                color={item.type === 'video' ? '#10B981' : '#8B5CF6'}
              />
            )}
          </View>
          <View style={styles.reportInfo}>
            <Text style={styles.reportType}>{item.type?.toUpperCase()} REPORT</Text>
            <Text style={styles.reportSender}>{sender.name}</Text>
            {sender.label ? <Text style={styles.anonymousLabel}>{sender.label}</Text> : null}
            <Text style={styles.reportDate}>{formatDate(item.created_at)}</Text>
          </View>
        </View>

        {item.caption ? <Text style={styles.caption}>{item.caption}</Text> : null}

        <View style={styles.reportActions}>
          {item.type === 'audio' && item.file_url && (
            <TouchableOpacity
              style={[
                styles.actionButton,
                isPlaying && !isPaused && styles.actionButtonActive,
                isLoading && styles.actionButtonLoading,
              ]}
              onPress={() => playAudio(item.file_url, reportId)}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <ActivityIndicator size="small" color="#8B5CF6" />
                  <Text style={[styles.actionText, styles.actionTextLoading]}>Loading...</Text>
                </>
              ) : (
                <>
                  <Ionicons
                    name={isPlaying ? (isPaused ? 'play' : 'pause') : 'play'}
                    size={20}
                    color={isPlaying && !isPaused ? '#fff' : '#8B5CF6'}
                  />
                  <Text style={[styles.actionText, isPlaying && !isPaused && styles.actionTextActive]}>
                    {isPlaying ? (isPaused ? 'Resume' : 'Pause') : 'Play'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {item.type === 'audio' && isPlaying && !isLoading && (
            <TouchableOpacity style={styles.actionButton} onPress={stopAudio}>
              <Ionicons name="stop" size={20} color="#EF4444" />
              <Text style={styles.actionText}>Stop</Text>
            </TouchableOpacity>
          )}

          {item.type === 'video' && item.file_url && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => openVideo(item.file_url)}
            >
              <Ionicons name="play-circle" size={20} color="#10B981" />
              <Text style={styles.actionText}>Watch</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              if (item.latitude && item.longitude) {
                setLocationModal({ visible: true, lat: item.latitude, lng: item.longitude, title: `${item.type?.toUpperCase()} Report Location` });
              } else {
                Alert.alert('Location', 'Location not available for this report');
              }
            }}
          >
            <Ionicons name="location" size={20} color="#F59E0B" />
            <Text style={styles.actionText}>Location</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.respondButton]}
            onPress={() => Alert.alert('Respond', 'Response feature coming soon.')}
          >
            <Ionicons name="checkmark-circle" size={20} color="#10B981" />
            <Text style={[styles.actionText, { color: '#10B981' }]}>Respond</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── Standardised video player modal (mirrors admin/reports.tsx) ──────────
  if (selectedVideoUrl) {
    const resolvedVideoUrl = resolveMediaUrl(selectedVideoUrl);

    const closePlayer = () => {
      setSelectedVideoUrl(null);
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

        {/* ── Standardised 16:9 wrapper with loading / error overlays ── */}
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
                <ActivityIndicator size="large" color="#8B5CF6" />
                <Text style={styles.videoOverlayText}>Loading video…</Text>
              </View>
            )}

            {videoStatus === 'error' && (
              <View style={styles.videoOverlay}>
                <Ionicons name="warning" size={40} color="#EF4444" />
                <Text style={styles.videoOverlayText}>Could not load video</Text>
                <TouchableOpacity
                  style={styles.videoRetryBtn}
                  onPress={() => setVideoStatus('loading')}
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
        <TouchableOpacity onPress={() => router.replace('/security/home')}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Nearby Reports ({reports.length})</Text>
        <TouchableOpacity onPress={onRefresh}>
          <Ionicons name="refresh" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#8B5CF6" />
        </View>
      ) : (
        <FlatList
          data={reports}
          renderItem={renderReport}
          keyExtractor={item => item._id || item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5CF6" />}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="document-text-outline" size={80} color="#64748B" />
              <Text style={styles.emptyText}>No reports nearby</Text>
              <Text style={styles.emptySubtext}>Pull to refresh</Text>
            </View>
          }
        />
      )}

      {locationModal && (
        <LocationMapModal
          visible={locationModal.visible}
          onClose={() => setLocationModal(null)}
          latitude={locationModal.lat}
          longitude={locationModal.lng}
          title={locationModal.title}
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

  reportCard:         { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 12 },
  reportHeader:       { flexDirection: 'row', alignItems: 'flex-start' },
  reportIcon:         { width: 50, height: 50, borderRadius: 12, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  reportUserAvatar:   { width: 50, height: 50, borderRadius: 25, borderWidth: 2, borderColor: '#3B82F6' },
  reportInfo:         { flex: 1 },
  reportType:         { fontSize: 14, fontWeight: '700', color: '#fff', marginBottom: 4 },
  reportSender:       { fontSize: 14, color: '#94A3B8', marginBottom: 2 },
  anonymousLabel:     { fontSize: 12, color: '#F59E0B', fontStyle: 'italic', marginBottom: 2 },
  reportDate:         { fontSize: 12, color: '#64748B' },
  caption:            { fontSize: 14, color: '#94A3B8', marginTop: 12, fontStyle: 'italic' },

  reportActions:      { flexDirection: 'row', marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#334155', gap: 8, flexWrap: 'wrap' },
  actionButton:       { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 8, backgroundColor: '#0F172A', minWidth: 80 },
  actionButtonActive: { backgroundColor: '#8B5CF6' },
  actionButtonLoading:{ backgroundColor: '#0F172A', opacity: 0.7 },
  actionText:         { fontSize: 13, color: '#94A3B8' },
  actionTextActive:   { color: '#fff' },
  actionTextLoading:  { color: '#8B5CF6' },
  respondButton:      { borderWidth: 1, borderColor: '#10B98140', backgroundColor: '#10B98110' },

  emptyContainer:     { alignItems: 'center', paddingVertical: 80 },
  emptyText:          { fontSize: 18, color: '#64748B', marginTop: 16 },
  emptySubtext:       { fontSize: 14, color: '#475569', marginTop: 4 },

  // ── Standardised video player styles (identical to admin/reports.tsx) ──
  videoHeader:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, backgroundColor: '#000' },
  videoTitle:         { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  videoScreenCenter:  { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  videoWrapper:       { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', position: 'relative' },
  videoPlayer:        { width: '100%', height: '100%' },
  videoOverlay:       { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center' },
  videoOverlayText:   { color: '#fff', fontSize: 16, marginTop: 12, fontWeight: '500' },
  videoRetryBtn:      { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#8B5CF6', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, marginTop: 16 },
  videoRetryText:     { color: '#fff', fontWeight: '600' },
});
