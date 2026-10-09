package ai.keen.mobile

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 必须在 onCreate 之前将主题设为 AppTheme，才能设置背景、状态栏和导航栏的颜色。
    // expo-splash-screen 依赖此设置。
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  /**
   * 返回从 JavaScript 注册的主组件名称，用于安排组件渲染。
   */
  override fun getMainComponentName(): String = "main"

  /**
   * 返回 [ReactActivityDelegate] 实例。这里使用 [DefaultReactActivityDelegate]，
   * 只需通过布尔标记 [fabricEnabled] 即可启用新架构。
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * 与 Android S 的返回键行为保持一致：将根 Activity 移至后台，而不是结束 Activity。
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // 对于非根 Activity，使用默认实现结束它们。
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // 在 Android S 上使用默认的返回键实现，
      // 因为它实际执行的操作不止 [Activity.moveTaskToBack]。
      super.invokeDefaultOnBackPressed()
  }
}
