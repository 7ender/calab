import { confirmAction } from '../../components/Confirm';
export const confirmIdentity = (options: { title: string; body: string; confirm: string; danger: boolean }): Promise<boolean> =>
  confirmAction(options.title, options.body, options.confirm, options.danger ? 'destructive' : 'primary');
