# 在此添加项目专用的 ProGuard 规则。
# 默认情况下，本文件中的标记会追加到
# /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt 中的标记之后。
# 修改 build.gradle 中的 proguardFiles 指令，可以调整包含路径及其顺序。
#
# 详情参见：
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated 规则
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# 在此添加项目专用的 keep 选项：
