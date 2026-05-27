'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import Navbar from '@/components/common/Navbar';
import {
  ArrowLeft,
  ClipboardList,
  FileText,
  AlertCircle,
  Phone,
  Mail,
  User,
} from 'lucide-react';

const STATUS_STYLES = {
  COMPLETED: 'bg-teal-500/10 text-teal-600',
  CANCELLED: 'bg-rose-500/10 text-rose-500',
  PENDING: 'bg-amber-500/10 text-amber-500',
};

export default function PatientHistoryRecords() {
  const { id } = useParams();
  const router = useRouter();
  const { user, token, API_BASE_URL } = useAuth();

  const [patient, setPatient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Auth gate — same pattern the dashboard uses.
  useEffect(() => {
    if (!user) router.push('/login');
  }, [user, router]);

  // Patient fetch — abortable so a quick back-nav doesn't strand the request
  // or call setState on an unmounted component.
  useEffect(() => {
    if (!token || !id) return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/patients/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to load patient record (${res.status}).`);
        }
        const data = await res.json();
        if (!cancelled) setPatient(data);
      } catch (err) {
        if (err.name === 'AbortError' || cancelled) return;
        setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, token, API_BASE_URL]);

  if (!user) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <main className="flex-1 max-w-5xl w-full mx-auto p-6 sm:p-8 space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>

        {loading && (
          <div className="glass p-12 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
            <div className="pulse-loader mx-auto">
              <div></div>
              <div></div>
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-400 animate-pulse">
              Loading diagnostic record...
            </p>
          </div>
        )}

        {!loading && error && (
          <div className="glass p-8 rounded-2xl border border-rose-500/30 flex items-start gap-4">
            <AlertCircle className="h-6 w-6 text-rose-500 shrink-0" />
            <div>
              <h3 className="font-extrabold text-rose-500">Unable to load patient record</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && patient && (
          <>
            {/* Demographics header */}
            <div className="glass p-6 sm:p-8 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-md">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-teal-500/10 text-teal-600 dark:text-teal-400 rounded-xl">
                  <User className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <h1 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    {patient.name}
                  </h1>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">
                    Diagnostic Reports Archive
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-2 mt-4 text-sm text-slate-500 dark:text-slate-400">
                    <span>
                      Age{' '}
                      <span className="font-bold text-slate-800 dark:text-slate-100">
                        {patient.age}
                      </span>
                    </span>
                    <span>
                      Gender{' '}
                      <span className="font-bold text-slate-800 dark:text-slate-100 capitalize">
                        {patient.gender}
                      </span>
                    </span>
                    {patient.phoneNumber && (
                      <span className="inline-flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5" /> {patient.phoneNumber}
                      </span>
                    )}
                    {patient.email && (
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5" /> {patient.email}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Clinical history */}
            <div className="glass p-6 sm:p-8 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-md">
              <h2 className="text-lg font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
                <ClipboardList className="h-5 w-5 text-teal-600" />
                Clinical Background
              </h2>
              {patient.medicalHistory && patient.medicalHistory.trim() ? (
                <p className="text-sm text-slate-700 dark:text-slate-300 leading-6 whitespace-pre-line">
                  {patient.medicalHistory}
                </p>
              ) : (
                <p className="text-sm text-slate-400 dark:text-slate-500 italic">
                  No medical history on file for this patient.
                </p>
              )}
            </div>

            {/* Appointments / diagnostic reports */}
            <div className="glass p-6 sm:p-8 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-md">
              <h2 className="text-lg font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
                <FileText className="h-5 w-5 text-teal-600" />
                Diagnostic Reports & Consultations
              </h2>

              {!patient.appointments || patient.appointments.length === 0 ? (
                <p className="text-sm text-slate-400 italic">
                  No diagnostic reports or consultations recorded.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-sm text-left">
                    <thead>
                      <tr className="text-slate-400 uppercase tracking-widest text-xxs font-bold border-b border-slate-200 dark:border-slate-800">
                        <th className="pb-3">Date &amp; Time</th>
                        <th className="pb-3">Physician</th>
                        <th className="pb-3">Reason</th>
                        <th className="pb-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {patient.appointments.map((app) => (
                        <tr key={app.id} className="hover:bg-slate-500/5 transition-colors">
                          <td className="py-3.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                            {new Date(app.appointmentDate).toLocaleString([], {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </td>
                          <td className="py-3.5 text-slate-500 dark:text-slate-400">
                            {app.doctor ? (
                              <>
                                <span className="font-bold text-slate-800 dark:text-slate-200">
                                  {app.doctor.name}
                                </span>
                                <span className="block text-xxs text-teal-600 dark:text-teal-400 font-semibold uppercase mt-0.5">
                                  {app.doctor.specialization}
                                </span>
                              </>
                            ) : (
                              <span className="italic text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-3.5 text-slate-500 dark:text-slate-400">
                            {app.reason || (
                              <span className="italic text-slate-400">No reason recorded</span>
                            )}
                          </td>
                          <td className="py-3.5 text-right">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded text-xxs font-extrabold tracking-wide uppercase ${
                                STATUS_STYLES[app.status] || 'bg-slate-500/10 text-slate-500'
                              }`}
                            >
                              {app.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
