document.addEventListener("WANSC-Initialize", () => {
  const OriginalNotification = Notification;

  function CustomNotification(title, options) {
    // Copy instead of mutating: the page may omit options or reuse the object.
    const silentOptions = { ...(options || {}), silent: true };
    const notification = new OriginalNotification(title, silentOptions);
    document.dispatchEvent(new CustomEvent("WANSC-Notification-Triggered"));
    return notification;
  }

  CustomNotification.prototype = OriginalNotification.prototype;
  CustomNotification.requestPermission = OriginalNotification.requestPermission.bind(OriginalNotification);
  CustomNotification.permission = OriginalNotification.permission;
  window.Notification = CustomNotification;
});