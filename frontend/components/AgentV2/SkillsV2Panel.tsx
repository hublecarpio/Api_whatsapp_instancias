'use client';

interface SkillsV2PanelProps {
  skills: {
    search_product: boolean;
    payment: boolean;
    followup: boolean;
    media: boolean;
    crm: boolean;
  };
  onToggleSkill: (skill: keyof SkillsV2PanelProps['skills']) => void;
  loading: boolean;
}

const SKILL_INFO = {
  search_product: {
    name: 'Busqueda de Productos',
    description: 'Busqueda semantica en el catalogo usando IA',
    icon: '🔍'
  },
  payment: {
    name: 'Links de Pago',
    description: 'Genera links de pago Stripe automaticamente',
    icon: '💳'
  },
  followup: {
    name: 'Seguimientos',
    description: 'Programa mensajes de seguimiento automaticos',
    icon: '📅'
  },
  media: {
    name: 'Multimedia',
    description: 'Envia imagenes y documentos del negocio',
    icon: '📸'
  },
  crm: {
    name: 'CRM Automatico',
    description: 'Gestiona tags, etapas e intenciones automaticamente',
    icon: '🏷️'
  }
};

export default function SkillsV2Panel({ skills, onToggleSkill, loading }: SkillsV2PanelProps) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Skills del Agente V2</h2>
          <p className="text-sm text-gray-400">
            Habilita o deshabilita las capacidades del agente
          </p>
        </div>
        <span className="px-3 py-1 bg-neon-purple/20 text-neon-purple rounded-full text-sm font-medium">
          V2 Avanzado
        </span>
      </div>

      <div className="grid gap-3">
        {(Object.keys(SKILL_INFO) as Array<keyof typeof SKILL_INFO>).map((skillKey) => {
          const skill = SKILL_INFO[skillKey];
          const isEnabled = skills[skillKey];

          return (
            <div
              key={skillKey}
              className={`flex items-center justify-between p-4 rounded-lg border transition-colors ${
                isEnabled
                  ? 'border-neon-purple/30 bg-neon-purple/5'
                  : 'border-dark-hover bg-dark-hover/30'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{skill.icon}</span>
                <div>
                  <h3 className="font-medium text-white">{skill.name}</h3>
                  <p className="text-sm text-gray-400">{skill.description}</p>
                </div>
              </div>
              <button
                onClick={() => onToggleSkill(skillKey)}
                disabled={loading}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                  isEnabled ? 'bg-neon-purple' : 'bg-dark-hover'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    isEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
