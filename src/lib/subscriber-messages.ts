const en = {
  subscribe: "Subscribe to map updates",
  calloutTitle: "See the network grow.",
  calloutBody: "Follow our progress with map updates delivered to your inbox.",
  intro:
    "Receive an email when a changed map is published. Verify your email using the invitation we send, then set a password.",
  consent:
    "I want to receive map-update emails. I can unsubscribe in email settings or using the link in an email.",
  sent: "Invitation sent. Check your inbox and spam folder. Open the invitation to verify your email and finish subscribing.",
  emailTaken:
    "This email already has an account. Sign in to manage your subscription.",
  nameTaken:
    "This name is already used by a collaborator or administrator. Please choose another.",
  invitationPending:
    "An invitation is already pending for this email. Use that invitation or wait for it to expire before requesting different details.",
  deliveryPending:
    "Your invitation is queued or being sent. Please wait before checking again.",
  deliveryFailed:
    "We could not send your invitation. Contact an administrator for help.",
  deliveryUnknown:
    "We could not confirm whether your invitation was sent. Check your inbox and spam folder. If it does not arrive, contact an administrator. We will not automatically send another email.",
  activateIntro:
    "Set a password to verify your email and subscribe to map updates. Your displayed name remains unverified.",
  subscriber: "Subscriber",
  deleteAccount: "Delete permanently",
  confirmDelete:
    "Permanently delete {name} ({email})? This removes their login, sessions and email settings, and frees the email for registration again. Shared contributions and delivery records remain. This cannot be undone.",
  accountDeleted:
    "Account permanently deleted. The email can be used to register again.",
  deleteBusy:
    "This account has running or unresolved work. Wait for current delivery to finish, or finish/reconcile its updates before deleting it.",
  deleteSelf: "You cannot delete your own account. Ask another administrator.",
  roleLabel: "Account role",
  saveRole: "Save role",
  replacementName: "Replacement display name (optional)",
  confirmRole:
    "Save account name {name} with role {role}? Its sessions will be revoked. Email preferences and historical contributions will be preserved.",
  nameConflict:
    "This name is protected by another collaborator or administrator. Enter a replacement display name before promotion.",
  mapEmails: "Map-update emails",
  mapEmailHint: "Email me when a changed map is successfully published.",
  discussionEmails: "Discussion notification emails",
  verificationRequired:
    "Verify your email before changing subscription settings.",
  quotaHint:
    "Map updates share the daily notification email limit. Updates above that limit are skipped and are not sent the next day.",
  accountHint:
    "Subscribers can participate as guests and manage map-update emails. Collaborator and administrator accounts require an invitation or promotion.",
  fixedName: "This name comes from your account and remains unverified.",
};
const zhCN: typeof en = {
  subscribe: "订阅地图更新",
  calloutTitle: "一起见证路网成长。",
  calloutBody: "订阅地图更新邮件，了解我们的建设进展。",
  intro: "地图更新发布后接收邮件。请通过我们发送的邀请验证邮箱并设置密码。",
  consent: "我希望接收地图更新邮件，可以在邮件设置或邮件中的链接取消订阅。",
  sent: "邀请邮件已发送。请检查收件箱和垃圾邮件，打开邀请以验证邮箱并完成订阅。",
  emailTaken: "此邮箱已有账户，请登录以管理订阅。",
  nameTaken: "此名称已由协作者或管理员使用，请选择其他名称。",
  invitationPending:
    "此邮箱已有待接受的邀请。请使用该邀请，或等待其过期后再填写其他信息申请。",
  deliveryPending: "邀请邮件正在排队或发送中，请稍后再查看。",
  deliveryFailed: "无法发送邀请邮件，请联系管理员寻求帮助。",
  deliveryUnknown:
    "暂时无法确认邀请邮件是否已发送。请检查收件箱和垃圾邮件；若未收到，请联系管理员。我们不会自动重复发送。",
  activateIntro: "设置密码以验证邮箱并订阅地图更新。您的显示名称仍未验证。",
  subscriber: "订阅者",
  deleteAccount: "永久删除",
  confirmDelete:
    "永久删除{name}（{email}）的账户？这将移除其登录凭据、会话和邮件设置，该邮箱可以重新注册。公开发言及投递记录会保留。此操作无法撤销。",
  accountDeleted: "账户已永久删除，该邮箱可以重新注册。",
  deleteBusy:
    "此账户仍有正在执行或待处理的任务。请等待邮件投递结束，或完成更新审核及异常核对后再删除。",
  deleteSelf: "不能删除自己的账户，请联系其他管理员。",
  roleLabel: "账户角色",
  saveRole: "保存角色",
  replacementName: "更改显示名称（可选）",
  confirmRole:
    "将账户名称保存为{name}，角色设为{role}？该账户的登录会话将失效，邮件偏好与历史发言将保留。",
  nameConflict:
    "此名称已由其他协作者或管理员使用，请在升级角色前输入新的显示名称。",
  mapEmails: "地图更新邮件",
  mapEmailHint: "地图更新成功发布后通过邮件通知我。",
  discussionEmails: "讨论通知邮件",
  verificationRequired: "请先验证邮箱，再更改订阅设置。",
  quotaHint:
    "地图更新与其他通知共享每日邮件上限。超过上限的更新将跳过，不会在次日补发。",
  accountHint:
    "订阅者可像访客一样参与讨论并管理地图更新邮件。协作者和管理员账户需要邀请或升级。",
  fixedName: "此名称来自您的账户，仍未验证。",
};
const zhHK: typeof en = {
  subscribe: "訂閱地圖更新",
  calloutTitle: "一起見證路網成長。",
  calloutBody: "訂閱地圖更新電郵，了解我們的建設進展。",
  intro: "地圖更新發佈後接收電郵。請透過我們寄出的邀請驗證電郵並設定密碼。",
  consent: "我希望接收地圖更新電郵，可以在電郵設定或電郵中的連結取消訂閱。",
  sent: "邀請電郵已寄出。請檢查收件箱和垃圾郵件，開啟邀請以驗證電郵並完成訂閱。",
  emailTaken: "此電郵已有帳戶，請登入以管理訂閱。",
  nameTaken: "此名稱已由協作者或管理員使用，請選擇其他名稱。",
  invitationPending:
    "此電郵已有待接受的邀請。請使用該邀請，或等待其到期後再填寫其他資料申請。",
  deliveryPending: "邀請電郵正在排隊或傳送中，請稍後再查看。",
  deliveryFailed: "無法寄出邀請電郵，請聯絡管理員尋求協助。",
  deliveryUnknown:
    "暫時無法確認邀請電郵是否已寄出。請檢查收件箱和垃圾郵件；若未收到，請聯絡管理員。我們不會自動重複寄出。",
  activateIntro: "設定密碼以驗證電郵並訂閱地圖更新。您的顯示名稱仍未驗證。",
  subscriber: "訂閱者",
  deleteAccount: "永久刪除",
  confirmDelete:
    "永久刪除{name}（{email}）的帳戶？這將移除其登入憑證、工作階段和電郵設定，該電郵可以重新註冊。公開發言及投遞紀錄會保留。此操作無法復原。",
  accountDeleted: "帳戶已永久刪除，該電郵可以重新註冊。",
  deleteBusy:
    "此帳戶仍有正在執行或待處理的工作。請等待電郵投遞結束，或完成更新審核及異常核對後再刪除。",
  deleteSelf: "不能刪除自己的帳戶，請聯絡其他管理員。",
  roleLabel: "帳戶角色",
  saveRole: "儲存角色",
  replacementName: "更改顯示名稱（可選）",
  confirmRole:
    "將帳戶名稱儲存為{name}，角色設為{role}？該帳戶的登入工作階段將失效，電郵偏好與歷史發言將保留。",
  nameConflict:
    "此名稱已由其他協作者或管理員使用，請在升級角色前輸入新的顯示名稱。",
  mapEmails: "地圖更新電郵",
  mapEmailHint: "地圖更新成功發佈後透過電郵通知我。",
  discussionEmails: "討論通知電郵",
  verificationRequired: "請先驗證電郵，再更改訂閱設定。",
  quotaHint:
    "地圖更新與其他通知共用每日電郵上限。超過上限的更新將略過，不會在翌日補發。",
  accountHint:
    "訂閱者可像訪客一樣參與討論並管理地圖更新電郵。協作者和管理員帳戶需要邀請或升級。",
  fixedName: "此名稱來自您的帳戶，仍未驗證。",
};
export function subscriberMessages(locale: string) {
  return locale === "zh-cn" ? zhCN : locale === "zh-hk" ? zhHK : en;
}
