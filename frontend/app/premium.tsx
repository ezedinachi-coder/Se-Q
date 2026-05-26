import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Alert, ActivityIndicator, Animated, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getAuthToken, saveAuthData, getUserMetadata, clearAuthData } from '../utils/auth';
import axios from 'axios';
import BACKEND_URL from '../utils/config';

const { width } = Dimensions.get('window');

type Plan = 'free' | 'annual' | 'lifetime';

const PLANS = [
  {
    id: 'free' as Plan,
    label: 'Free',
    badge: 'Current Plan',
    badgeColor: '#33415540',
    badgeText: '#94A3B8',
    price: '$0',
    period: 'forever',
    sub: 'Your active plan',
    accentColor: '#475569',
    selectedBorder: '#475569',
    icon: 'shield-outline' as const,
    features: [
      { text: 'Panic Alerts',                included: true  },
      { text: 'Audio & Video Reports (5/mo)', included: true  },
      { text: 'Basic Messaging',             included: true  },
      { text: 'Security Escort',             included: false },
      { text: 'Priority Response',           included: false },
      { text: 'Unlimited Reports',           included: false },
    ],
  },
  {
    id: 'annual' as Plan,
    label: 'Annual',
    badge: 'Most Popular',
    badgeColor: '#D9770618',
    badgeText: '#FB923C',
    price: '$10',
    period: 'per year',
    sub: '~$0.83 / month',
    accentColor: '#F59E0B',
    selectedBorder: '#F59E0B',
    icon: 'star' as const,
    features: [
      { text: 'Everything in Free',          included: true  },
      { text: 'Security Escort',             included: true  },
      { text: 'Priority Response',           included: true  },
      { text: 'Unlimited Reports',           included: true  },
      { text: 'Enhanced Privacy',            included: true  },
      { text: 'Renews annually',             included: true  },
    ],
  },
  {
    id: 'lifetime' as Plan,
    label: 'Lifetime',
    badge: 'Best Value',
    badgeColor: '#7C3AED18',
    badgeText: '#A78BFA',
    price: '$50',
    period: 'one-time',
    sub: 'Pay once, own forever',
    accentColor: '#8B5CF6',
    selectedBorder: '#8B5CF6',
    icon: 'diamond' as const,
    features: [
      { text: 'Everything in Annual',        included: true  },
      { text: 'Lifetime Access',             included: true  },
      { text: 'All Future Features',         included: true  },
      { text: 'VIP Priority Support',        included: true  },
      { text: 'No Renewal Required',         included: true  },
      { text: 'Early Access to New Features',included: true  },
    ],
  },
];

export default function Premium() {
  const router = useRouter();
  const [loading, setLoading]           = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<Plan>('annual');

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 1800, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const handleUpgrade = async () => {
    if (selectedPlan === 'free') return;
    setLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      await axios.post(
        `${BACKEND_URL}/api/payment/verify`,
        { reference: `${selectedPlan.toUpperCase()}_${Date.now()}`, plan: selectedPlan },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );

      const metadata = await getUserMetadata();
      await saveAuthData({ token, user_id: metadata.userId || '', role: metadata.role || 'civil', is_premium: true });

      const planLabel = selectedPlan === 'annual' ? 'Annual' : 'Lifetime';
      Alert.alert("You're Premium! 🎉", `Your ${planLabel} subscription is now active. Enjoy all premium features.`, [
        { text: "Let's Go", onPress: () => router.replace('/civil/home') },
      ]);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        Alert.alert('Session Expired', 'Please login again.');
        await clearAuthData();
        router.replace('/auth/login');
      } else {
        const token = await getAuthToken();
        const metadata = await getUserMetadata();
        if (token) {
          await saveAuthData({ token, user_id: metadata.userId || '', role: metadata.role || 'civil', is_premium: true });
          const planLabel = selectedPlan === 'annual' ? 'Annual' : 'Lifetime';
          Alert.alert("You're Premium! 🎉", `${planLabel} plan activated. (Demo Mode)`, [
            { text: "Let's Go", onPress: () => router.replace('/civil/home') },
          ]);
        } else {
          Alert.alert('Error', 'Upgrade failed. Please try again.');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const activePlan = PLANS.find(p => p.id === selectedPlan)!;
  const ctaColor   = selectedPlan === 'lifetime' ? '#8B5CF6'
                   : selectedPlan === 'annual'   ? '#F59E0B'
                   : '#1E293B';
  const ctaTextColor = selectedPlan === 'annual' ? '#0F172A' : '#fff';

  return (
    <SafeAreaView style={styles.container}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.replace('/civil/home')}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Choose a Plan</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <Animated.View style={{ opacity: fadeAnim }}>

          {/* ── Hero ─────────────────────────────────────────────────────── */}
          <View style={styles.hero}>
            <Animated.View style={[styles.heroRing, { transform: [{ scale: pulseAnim }] }]}>
              <View style={styles.heroCore}>
                <Ionicons name="shield-checkmark" size={36} color="#F59E0B" />
              </View>
            </Animated.View>
            <Text style={styles.heroTitle}>Upgrade to Premium</Text>
            <Text style={styles.heroSub}>Advanced security protection, on your terms.</Text>
          </View>

          {/* ── Plan Cards ───────────────────────────────────────────────── */}
          <View style={styles.cards}>
            {PLANS.map((plan) => {
              const active = selectedPlan === plan.id;
              return (
                <TouchableOpacity
                  key={plan.id}
                  activeOpacity={0.82}
                  onPress={() => setSelectedPlan(plan.id)}
                  style={[
                    styles.card,
                    plan.id === 'annual' && styles.cardFeatured,
                    active && { borderColor: plan.selectedBorder, borderWidth: 1.5 },
                  ]}
                >
                  {/* Top row */}
                  <View style={styles.cardTop}>
                    <View style={[styles.planIcon, { backgroundColor: plan.accentColor + '18' }]}>
                      <Ionicons name={plan.icon} size={20} color={plan.accentColor} />
                    </View>
                    <View style={styles.planMeta}>
                      <Text style={styles.planName}>{plan.label}</Text>
                      <Text style={styles.planSub}>{plan.sub}</Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: plan.badgeColor }]}>
                      <Text style={[styles.badgeText, { color: plan.badgeText }]}>{plan.badge}</Text>
                    </View>
                  </View>

                  {/* Price */}
                  <View style={styles.priceRow}>
                    <Text style={[styles.price, { color: plan.accentColor }]}>{plan.price}</Text>
                    <Text style={styles.period}> / {plan.period}</Text>
                  </View>

                  <View style={styles.divider} />

                  {/* Features */}
                  <View style={styles.featureList}>
                    {plan.features.map((f, i) => (
                      <View key={i} style={styles.featureRow}>
                        <View style={[
                          styles.featureIconBox,
                          { backgroundColor: f.included ? '#10B98118' : '#33415530' },
                        ]}>
                          <Ionicons
                            name={f.included ? 'checkmark' : 'lock-closed'}
                            size={12}
                            color={f.included ? '#10B981' : '#475569'}
                          />
                        </View>
                        <Text style={[styles.featureText, !f.included && styles.featureLocked]}>
                          {f.text}
                        </Text>
                      </View>
                    ))}
                  </View>

                  {/* Selected pill */}
                  {active && (
                    <View style={[
                      styles.selectedPill,
                      { backgroundColor: plan.accentColor + '20', borderColor: plan.accentColor + '50' },
                    ]}>
                      <Ionicons name="checkmark-circle" size={13} color={plan.accentColor} />
                      <Text style={[styles.selectedText, { color: plan.accentColor }]}>Selected</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* ── CTA ──────────────────────────────────────────────────────── */}
          <View style={styles.ctaWrap}>
            <TouchableOpacity
              style={[styles.ctaBtn, { backgroundColor: ctaColor }, (selectedPlan === 'free' || loading) && styles.ctaDisabled]}
              onPress={handleUpgrade}
              disabled={selectedPlan === 'free' || loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator color={ctaTextColor} />
              ) : selectedPlan === 'free' ? (
                <Text style={[styles.ctaLabel, { color: '#64748B' }]}>You're on the Free plan</Text>
              ) : (
                <>
                  <Text style={[styles.ctaLabel, { color: ctaTextColor }]}>
                    Get {activePlan.label} — {activePlan.price}
                  </Text>
                  <Ionicons name="arrow-forward" size={18} color={ctaTextColor} />
                </>
              )}
            </TouchableOpacity>

            <Text style={styles.disclaimer}>
              Secure checkout · No hidden fees · Cancel anytime{'\n'}
              Paystack payment integration pending
            </Text>
          </View>

        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#080E1A' },

  // Header
  header:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  backBtn:        { width: 36, height: 36, borderRadius: 10, backgroundColor: '#1E293B', justifyContent: 'center', alignItems: 'center' },
  headerTitle:    { fontSize: 17, fontWeight: '600', color: '#E2E8F0', letterSpacing: 0.2 },

  scrollContent:  { paddingBottom: 52 },

  // Hero
  hero:           { alignItems: 'center', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 32 },
  heroRing:       { width: 88, height: 88, borderRadius: 44, backgroundColor: '#F59E0B0D', borderWidth: 1, borderColor: '#F59E0B30', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  heroCore:       { width: 64, height: 64, borderRadius: 32, backgroundColor: '#F59E0B18', justifyContent: 'center', alignItems: 'center' },
  heroTitle:      { fontSize: 26, fontWeight: '700', color: '#F1F5F9', textAlign: 'center', letterSpacing: -0.3 },
  heroSub:        { fontSize: 14, color: '#64748B', textAlign: 'center', marginTop: 8, lineHeight: 21, maxWidth: 260 },

  // Cards
  cards:          { paddingHorizontal: 16, gap: 12 },
  card:           { backgroundColor: '#111827', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: '#1E293B' },
  cardFeatured:   { backgroundColor: '#0D1B2A' },

  cardTop:        { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  planIcon:       { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  planMeta:       { flex: 1 },
  planName:       { fontSize: 16, fontWeight: '700', color: '#F1F5F9', letterSpacing: 0.1 },
  planSub:        { fontSize: 12, color: '#64748B', marginTop: 2 },
  badge:          { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 20 },
  badgeText:      { fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },

  priceRow:       { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 16 },
  price:          { fontSize: 38, fontWeight: '800', lineHeight: 42, letterSpacing: -1 },
  period:         { fontSize: 14, color: '#64748B', marginBottom: 5 },

  divider:        { height: 1, backgroundColor: '#1E293B', marginBottom: 16 },

  featureList:    { gap: 10 },
  featureRow:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  featureIconBox: { width: 22, height: 22, borderRadius: 6, justifyContent: 'center', alignItems: 'center' },
  featureText:    { fontSize: 13.5, color: '#CBD5E1', flex: 1 },
  featureLocked:  { color: '#475569' },

  selectedPill:   { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 16, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1 },
  selectedText:   { fontSize: 12, fontWeight: '600' },

  // CTA
  ctaWrap:        { paddingHorizontal: 16, paddingTop: 24, gap: 14 },
  ctaBtn:         { borderRadius: 14, paddingVertical: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaDisabled:    { opacity: 0.55 },
  ctaLabel:       { fontSize: 16, fontWeight: '700', letterSpacing: 0.1 },
  disclaimer:     { fontSize: 12, color: '#334155', textAlign: 'center', lineHeight: 18 },
});
