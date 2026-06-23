// frontend/src/components/Billing.jsx
import React, { useEffect, useState } from 'react'
import { apiFetch } from '../utils/api.js'

function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (document.getElementById('rzp-script')) return resolve(true)
    const s = document.createElement('script')
    s.id = 'rzp-script'
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve(true)
    s.onerror = () => resolve(false)
    document.body.appendChild(s)
  })
}

export default function Billing() {
  const [billing, setBilling] = useState(null)
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [upgrading, setUpgrading] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      apiFetch('/api/billing/status'),
      apiFetch('/api/billing/plans'),
    ]).then(([b, p]) => {
      setBilling(b.data)
      setPlans(p.data)
    }).finally(() => setLoading(false))
  }, [])

  async function handleUpgrade(plan) {
    setError('')
    setUpgrading(plan.plan_id)
    try {
      const ok = await loadRazorpayScript()
      if (!ok) throw new Error('Failed to load Razorpay checkout. Check your internet connection.')

      const res = await apiFetch('/api/billing/subscribe', {
        method: 'POST',
        body: JSON.stringify({ plan_id: plan.plan_id }),
      })
      if (!res.success) throw new Error(res.error || 'Failed to create subscription')

      const { subscription_id, razorpay_key, plan_name, amount } = res.data

      await new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: razorpay_key,
          subscription_id,
          name: 'FixMyLeads',
          description: plan_name + ' Plan',
          currency: 'INR',
          amount: parseFloat(amount) * 100,
          theme: { color: '#3B82F6' },
          handler: () => resolve(),
          modal: { ondismiss: () => reject(new Error('Payment cancelled')) },
        })
        rzp.open()
      })

      // Refresh billing status after successful payment
      const updated = await apiFetch('/api/billing/status')
      setBilling(updated.data)
    } catch (e) {
      setError(e.message)
    } finally {
      setUpgrading(null)
    }
  }

  if (loading) return <div className="p-6 text-gray-400">Loading billing info...</div>

  const trialDaysLeft = billing?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(billing.trial_ends_at) - Date.now()) / 86400000))
    : 0

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Billing & Plan</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {/* Current Plan Card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-100 dark:border-gray-700 shadow-sm mb-6">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Current Plan</div>
            <div className="text-xl font-bold text-gray-900 dark:text-white mt-1">{billing?.plan_name || 'No plan selected'}</div>
            {billing?.price_monthly && (
              <div className="text-2xl font-bold text-blue-600 mt-1">₹{Number(billing.price_monthly).toLocaleString('en-IN')}/mo</div>
            )}
          </div>
          <span className={`text-xs px-3 py-1 rounded-full font-medium ${
            billing?.subscription_status === 'active'  ? 'bg-green-100 text-green-700' :
            billing?.subscription_status === 'trial'   ? 'bg-yellow-100 text-yellow-700' :
            'bg-gray-100 text-gray-600'
          }`}>
            {billing?.subscription_status === 'trial'
              ? `Trial — ${trialDaysLeft} days left`
              : billing?.subscription_status || 'trial'}
          </span>
        </div>

        {billing?.features && (
          <ul className="mt-4 text-sm text-gray-600 dark:text-gray-400 space-y-1">
            {Object.entries(billing.features).map(([k, v]) => (
              <li key={k}>✓ {k.replace(/_/g, ' ')}: {v === true ? 'Yes' : v === -1 ? 'Unlimited' : v}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Upgrade Plans */}
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Choose a Plan</h2>
      <div className="space-y-3">
        {plans.filter(p => p.plan_id !== String(billing?.plan_id)).map(plan => (
          <div key={plan.plan_id} className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 flex justify-between items-center">
            <div>
              <div className="font-semibold text-gray-900 dark:text-white">{plan.name}</div>
              <div className="text-sm text-blue-600 font-bold">₹{Number(plan.price_monthly).toLocaleString('en-IN')}/mo</div>
              {plan.features && (
                <div className="text-xs text-gray-400 mt-1">
                  {Object.entries(plan.features).slice(0, 3).map(([k, v]) =>
                    v === true ? k.replace(/_/g, ' ') : null
                  ).filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <button
              onClick={() => handleUpgrade(plan)}
              disabled={upgrading === plan.plan_id}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm px-4 py-2 rounded-lg font-medium min-w-[90px]"
            >
              {upgrading === plan.plan_id ? 'Opening...' : 'Upgrade'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
