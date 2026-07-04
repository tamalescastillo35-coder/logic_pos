import React, { useState } from 'react';
import { Building2, Sparkles, LogOut, Check, ArrowRight, Key, Trash2 } from 'lucide-react';

interface Company {
  id: string;
  name: string;
  role: 'owner' | 'master_admin' | 'admin' | 'employee';
}

interface CompanySelectorProps {
  companies: { [id: string]: Company };
  onCreateCompany: (name: string) => Promise<void>;
  onJoinWithCode: (code: string) => Promise<void>;
  onSelectCompany: (id: string) => void;
  onLogout: () => void;
  onDeleteCompany?: (id: string) => Promise<void>;
  userDisplayName: string | null;
  userEmail: string | null;
}

export default function CompanySelector({
  companies,
  onCreateCompany,
  onJoinWithCode,
  onSelectCompany,
  onLogout,
  onDeleteCompany,
  userDisplayName,
  userEmail
}: CompanySelectorProps) {
  const [activeTab, setActiveTab] = useState<'select' | 'create' | 'join'>('select');
  const [companyName, setCompanyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleDeleteClick = async (id: string, name: string) => {
    const firstConfirm = window.confirm(`⚠️ ADVERTENCIA ⚠️\n¿Estás seguro de que deseas eliminar permanentemente la empresa "${name}"? Esta acción borrará de manera irreversible todos los productos, registros de inventario, ventas y cierres de caja.`);
    if (!firstConfirm) return;

    const secondConfirm = window.confirm(`⏳ CONFIRMACIÓN CRÍTICA SEGUNDA SEPARADA ⏳\nLa eliminación de "${name}" es definitiva y no tiene retorno. ¿Aceptas continuar con la eliminación completa de todos los datos en la nube?`);
    if (!secondConfirm) return;

    if (onDeleteCompany) {
      setIsSubmitting(true);
      try {
        await onDeleteCompany(id);
      } catch (err) {
        console.error(err);
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const companyList = Object.values(companies);

  // Auto fallback if there are no companies, point to create tab
  if (companyList.length === 0 && activeTab === 'select') {
    setActiveTab('create');
  }

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;
    setIsSubmitting(true);
    try {
      await onCreateCompany(companyName);
      setCompanyName('');
    } catch (_) {
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setIsSubmitting(true);
    try {
      await onJoinWithCode(inviteCode);
      setInviteCode('');
    } catch (_) {
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/95 flex items-center justify-center p-4 antialiased">
      <div className="w-full max-w-lg bg-slate-950 border border-slate-800 rounded-3xl shadow-2xl shadow-indigo-950/40 overflow-hidden flex flex-col">
        
        {/* Upper Brand Info */}
        <div className="bg-gradient-to-r from-slate-900 to-indigo-950 px-6 py-8 border-b border-slate-850 text-center relative">
          <div className="mx-auto w-14 h-14 bg-indigo-500/10 rounded-2xl border border-indigo-500/20 flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-indigo-400" />
          </div>
          <h2 className="text-2xl font-black text-slate-100 tracking-tight">Sistema POS</h2>
          <p className="text-slate-400 text-xs mt-1 bg-slate-900/60 inline-block px-3 py-1 rounded-full border border-slate-800">
            Conectado como <strong className="text-indigo-300 font-bold">{userDisplayName || userEmail}</strong>
          </p>
        </div>

        {/* Tab Controls Selector */}
        <div className="flex border-b border-slate-850 px-4 bg-slate-900/40">
          {companyList.length > 0 && (
            <button
              onClick={() => setActiveTab('select')}
              className={`flex-1 text-center py-3.5 text-xs font-black uppercase tracking-wider transition cursor-pointer ${
                activeTab === 'select'
                  ? 'border-b-2 border-indigo-500 text-slate-100'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Mis Empresas
            </button>
          )}
          <button
            onClick={() => setActiveTab('create')}
            className={`flex-1 text-center py-3.5 text-xs font-black uppercase tracking-wider transition cursor-pointer ${
              activeTab === 'create'
                ? 'border-b-2 border-indigo-500 text-slate-100'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Nueva Empresa
          </button>
          <button
            onClick={() => setActiveTab('join')}
            className={`flex-1 text-center py-3.5 text-xs font-black uppercase tracking-wider transition cursor-pointer ${
              activeTab === 'join'
                ? 'border-b-2 border-indigo-500 text-slate-100'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Unirse por Código
          </button>
        </div>

        {/* Dynamic Display Area */}
        <div className="p-6 flex-grow">
          {activeTab === 'select' && companyList.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs text-slate-400 mb-2">Selecciona la empresa con la que deseas operar hoy:</p>
              <div className="space-y-2.5 max-h-56 overflow-y-auto pr-1">
                {companyList.map((company) => (
                  <div
                    key={company.id}
                    className="w-full bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-slate-700/85 text-left p-4 rounded-2xl flex items-center justify-between transition duration-150 group"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectCompany(company.id)}
                      className="flex-grow items-center space-x-3 text-left cursor-pointer flex min-w-0"
                    >
                      <div className="p-2 bg-indigo-950 border border-indigo-900 rounded-lg group-hover:scale-105 transition shrink-0">
                        <Building2 className="w-5 h-5 text-indigo-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-extrabold text-sm text-slate-200 truncate">{company.name}</h4>
                        <span className="text-[10px] text-indigo-400 font-bold uppercase py-0.5 px-2 bg-indigo-950 border border-indigo-900/50 rounded mt-1 inline-block truncate max-w-full">
                          {company.role === 'owner' ? 'Propietario' : company.role === 'master_admin' ? 'Master Admin' : company.role === 'admin' ? 'Administrador' : 'Empleado'}
                        </span>
                      </div>
                    </button>
                    
                    <div className="flex items-center space-x-2">
                      {company.role === 'owner' && onDeleteCompany && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClick(company.id, company.name);
                          }}
                          className="p-2 text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 rounded-xl transition cursor-pointer disabled:opacity-50"
                          title="Eliminar Empresa de Forma Permanente"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectCompany(company.id)}
                        className="p-2 text-slate-500 group-hover:text-indigo-400 group-hover:translate-x-1 transition cursor-pointer"
                      >
                        <ArrowRight className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'create' && (
            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div className="space-y-1.5 text-left">
                <label className="text-xs text-slate-300 font-bold">Nombre de la Empresa / Comercio</label>
                <input
                  type="text"
                  placeholder="Ej. Burguer & Papas Central, Zapatería Express..."
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-500 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  required
                  disabled={isSubmitting}
                />
              </div>
              <div className="p-3 bg-indigo-950/20 border border-indigo-900/40 rounded-xl text-left">
                <p className="text-[11px] text-indigo-300 leading-relaxed">
                  <strong>Paso de Inicialización Automática:</strong> Al crear tu empresa, LOGIC POS importará automáticamente la base de datos de productos por defecto para que puedas comenzar a operar sin demoras.
                </p>
              </div>
              <button
                type="submit"
                disabled={isSubmitting || !companyName.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black text-sm py-3 px-4 rounded-xl shadow-lg shadow-indigo-900/20 cursor-pointer transition flex items-center justify-center space-x-1.5 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <span>Registrando en la nube...</span>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-indigo-200" />
                    <span>Crear Empresa y Activar</span>
                  </>
                )}
              </button>
            </form>
          )}

          {activeTab === 'join' && (
            <form onSubmit={handleJoinSubmit} className="space-y-4">
              <div className="space-y-1.5 text-left">
                <label className="text-xs text-slate-300 font-bold">Código de Invitación de Empleado</label>
                <div className="relative">
                  <Key className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    placeholder="Ej. INV-12345"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-slate-100 placeholder-slate-500 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono transition uppercase"
                    required
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              <div className="p-3 bg-amber-950/20 border border-amber-900/30 rounded-xl text-left">
                <p className="text-[11px] text-amber-300 leading-relaxed">
                  <strong>Ingreso a Equipo:</strong> Ingresa el código entregado por tu administrador. Te integrarás automáticamente a su comercio en tiempo real con permisos de Empleado.
                </p>
              </div>
              <button
                type="submit"
                disabled={isSubmitting || !inviteCode.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black text-sm py-3 px-4 rounded-xl shadow-lg shadow-blue-900/20 cursor-pointer transition flex items-center justify-center space-x-1.5 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <span>Conectando...</span>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Unirse a Comercio</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        {/* Global Footer Exit buttons */}
        <div className="bg-slate-900/80 px-6 py-4 border-t border-slate-850 flex justify-between items-center text-xs">
          <span className="text-slate-500 font-bold">LOGIC POS</span>
          <button
            onClick={onLogout}
            className="flex items-center space-x-1.5 text-red-400 hover:text-red-300 font-extrabold tracking-wide cursor-pointer uppercase py-1 px-2.5 rounded bg-red-950/40 hover:bg-red-950 border border-red-900/30 transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Cerrar Sesión</span>
          </button>
        </div>

      </div>
    </div>
  );
}
