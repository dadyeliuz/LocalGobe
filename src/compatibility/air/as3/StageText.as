package flash.text
{
   import flash.display.BitmapData;
   import flash.display.Stage;
   import flash.events.Event;
   import flash.events.EventDispatcher;
   import flash.events.FocusEvent;
   import flash.geom.Rectangle;

   /**
    * Clean-room LocalGobe AIR compatibility shim for flash.text.StageText.
    * Delegates native mobile text input to a standard AVM2 input TextField so
    * Mogobe Android login/chat fields work seamlessly in Ruffle Web.
    */
   public class StageText extends EventDispatcher
   {
      private var _field:TextField;
      private var _stage:Stage;
      private var _viewPort:Rectangle;
      private var _text:String = "";
      private var _fontFamily:String = "Arial";
      private var _fontSize:int = 14;
      private var _textAlign:String = "right";
      private var _color:uint = 0x000000;
      private var _maxChars:int = 0;
      private var _displayAsPassword:Boolean = false;
      private var _visible:Boolean = true;
      private var _editable:Boolean = true;

      public var multiline:Boolean = false;
      public var autoCapitalize:String = "none";
      public var autoCorrect:Boolean = false;
      public var fontPosture:String = "normal";
      public var fontWeight:String = "normal";
      public var locale:String = "";
      public var restrict:String = null;
      public var returnKeyLabel:String = "default";
      public var softKeyboardType:String = "default";

      public function StageText(initOptions:* = null)
      {
         super();
         if (initOptions != null && initOptions.multiline != null)
         {
            this.multiline = Boolean(initOptions.multiline);
         }
         _field = new TextField();
         _field.type = TextFieldType.INPUT;
         _field.multiline = this.multiline;
         _field.wordWrap = this.multiline;
         _field.selectable = true;
         _field.addEventListener(Event.CHANGE, onInternalChange);
         _field.addEventListener(FocusEvent.FOCUS_IN, onInternalFocusIn);
         _field.addEventListener(FocusEvent.FOCUS_OUT, onInternalFocusOut);
      }

      private function onInternalChange(e:Event):void
      {
         _text = _field.text;
         dispatchEvent(new Event(Event.CHANGE));
      }

      private function onInternalFocusIn(e:FocusEvent):void
      {
         dispatchEvent(new FocusEvent(FocusEvent.FOCUS_IN));
      }

      private function onInternalFocusOut(e:FocusEvent):void
      {
         dispatchEvent(new FocusEvent(FocusEvent.FOCUS_OUT));
      }

      public function get text():String
      {
         return _field != null ? _field.text : _text;
      }

      public function set text(val:String):void
      {
         _text = val != null ? val : "";
         if (_field != null)
         {
            _field.text = _text;
            applyFormat();
         }
      }

      public function get viewPort():Rectangle { return _viewPort; }

      public function set viewPort(rect:Rectangle):void
      {
         _viewPort = rect;
         if (_field != null && rect != null)
         {
            _field.x = rect.x;
            _field.y = rect.y;
            _field.width = rect.width;
            _field.height = rect.height;
         }
      }

      public function get stage():Stage { return _stage; }

      public function set stage(stg:Stage):void
      {
         if (_stage != null && _field != null && _field.parent != null)
         {
            _field.parent.removeChild(_field);
         }
         _stage = stg;
         if (_stage != null && _field != null)
         {
            _stage.addChild(_field);
            applyFormat();
         }
      }

      public function get visible():Boolean { return _visible; }

      public function set visible(val:Boolean):void
      {
         _visible = val;
         if (_field != null) _field.visible = val;
      }

      public function get editable():Boolean { return _editable; }

      public function set editable(val:Boolean):void
      {
         _editable = val;
         if (_field != null) _field.type = val ? TextFieldType.INPUT : TextFieldType.DYNAMIC;
      }

      public function get displayAsPassword():Boolean { return _displayAsPassword; }

      public function set displayAsPassword(val:Boolean):void
      {
         _displayAsPassword = val;
         if (_field != null) _field.displayAsPassword = val;
      }

      public function get maxChars():int { return _maxChars; }

      public function set maxChars(val:int):void
      {
         _maxChars = val;
         if (_field != null) _field.maxChars = val;
      }

      public function get fontFamily():String { return _fontFamily; }
      public function set fontFamily(val:String):void { _fontFamily = val; applyFormat(); }

      public function get fontSize():int { return _fontSize; }
      public function set fontSize(val:int):void { _fontSize = val; applyFormat(); }

      public function get textAlign():String { return _textAlign; }
      public function set textAlign(val:String):void { _textAlign = val; applyFormat(); }

      public function get color():uint { return _color; }
      public function set color(val:uint):void { _color = val; applyFormat(); }

      private function applyFormat():void
      {
         if (_field != null)
         {
            var tf:TextFormat = new TextFormat(_fontFamily, _fontSize, _color);
            tf.align = _textAlign;
            _field.defaultTextFormat = tf;
            _field.setTextFormat(tf);
         }
      }

      public function assignFocus():void
      {
         if (_stage != null && _field != null)
         {
            _stage.focus = _field;
         }
      }

      public function selectRange(anchorIndex:int, activeIndex:int):void
      {
         if (_field != null) _field.setSelection(anchorIndex, activeIndex);
      }

      public function drawViewPortToBitmapData(bitmap:BitmapData):void
      {
         if (_field != null && bitmap != null) bitmap.draw(_field);
      }

      public function dispose():void
      {
         if (_field != null)
         {
            if (_field.parent != null) _field.parent.removeChild(_field);
            _field = null;
         }
         _stage = null;
      }
   }
}
