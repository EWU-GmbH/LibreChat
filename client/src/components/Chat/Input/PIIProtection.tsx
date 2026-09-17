import React, { memo } from 'react';
import { ShieldCheck } from 'lucide-react';
import { CheckboxButton } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';

function PIIProtection() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  if (!context) {
    return null;
  }

  const { toggleState, debouncedChange } = context.piiProtection;

  return (
    <CheckboxButton
      className="max-w-fit"
      checked={toggleState === true}
      setValue={debouncedChange}
      label={localize('com_ui_pii_protection')}
      isCheckedClassName="border-emerald-600/40 bg-emerald-500/10 hover:bg-emerald-700/10"
      icon={<ShieldCheck className="icon-md" aria-hidden="true" />}
    />
  );
}

export default memo(PIIProtection);
