(* =====================================================================================================
   TREND BUFFER - Delta AH500 (ISPSoft, Structured Text)                     FSTP-200 OP panel, Medge Controls
   Keeps the plant history in the PLC while no dashboard PC is connected. Every LOG_HDR[1] minutes
   (default 2) it stores the clock time + the 11 analog values in a ring buffer:
       D20000 - D20019   header  (LOG_HDR)
       D20020 - D32619   1050 records x 12 words  (LOG_REC)  = 35 h at 2 min, 52 h at 3 min, 3.6 days at 5 min
   When the dashboard connects it reads this buffer and fills the gaps in its trends (backend/app/plc_buffer.py).

   ADD TO THE PROGRAM (cyclic task, called every scan):
     1. Global symbols (Global Symbols table):
          LOG_HDR   ARRAY[0..19]    OF WORD   address D20000
          LOG_REC   ARRAY[0..12599] OF WORD   address D20020
        Check first in ISPSoft (Device Monitor / cross reference) that D20000-D32619 are NOT used anywhere.
     2. Make D20000-D32619 LATCHED (HWCONFIG > CPU > Latched area) so the history survives a PLC power cut.
     3. Local variables of this POU:
          Rtc       ARRAY[0..6] OF WORD
          LastMin   INT := -1
          MinOfDay  INT
          Ivl       INT
          Base      INT
          K         INT
          R         REAL
          Vals      ARRAY[0..10] OF REAL
          Scl       ARRAY[0..10] OF REAL := [10.0,10.0,10.0,10.0, 10.0,10.0, 100.0, 100.0,100.0,100.0,100.0]
     4. Clock: TRD reads the real-time clock into 7 words. VERIFY the order in the ISPSoft help for TRD on
        your firmware (expected: Rtc[0]=year, Rtc[1]=month, Rtc[2]=day, Rtc[3]=hour, Rtc[4]=minute,
        Rtc[5]=second, Rtc[6]=week). If it differs, change the three Rtc[...] indexes marked <<< below.
        The PLC clock must be set to local (IST) time.
   Interval: write 1..60 into D20001 (from the HMI if you like). Do not change the layout words D20002/D20006/D20007.
   ===================================================================================================== *)

(* first run or layout changed: initialise the header (buffer starts empty) *)
IF (LOG_HDR[0] <> 16#4C47) OR (LOG_HDR[2] <> 1050) OR (LOG_HDR[6] <> 12) OR (LOG_HDR[7] <> 11) THEN
    LOG_HDR[0] := 16#4C47;      (* magic "LG" - the dashboard looks for this *)
    LOG_HDR[1] := 2;            (* interval, minutes *)
    LOG_HDR[2] := 1050;         (* capacity, records *)
    LOG_HDR[3] := 0;            (* next write index *)
    LOG_HDR[4] := 0;            (* records written, low word *)
    LOG_HDR[5] := 0;            (* records written, high word *)
    LOG_HDR[6] := 12;           (* words per record *)
    LOG_HDR[7] := 11;           (* channels *)
    LOG_HDR[8] := 1;            (* layout version *)
END_IF;
Ivl := WORD_TO_INT(LOG_HDR[1]);
IF (Ivl < 1) OR (Ivl > 60) THEN
    Ivl := 2;
    LOG_HDR[1] := 2;
END_IF;

TRD(Rtc[0]);
MinOfDay := WORD_TO_INT(Rtc[3]) * 60 + WORD_TO_INT(Rtc[4]);          (* <<< hour, minute *)

IF MinOfDay <> LastMin THEN                                            (* once per new minute *)
    LastMin := MinOfDay;
    IF (MinOfDay MOD Ivl) = 0 THEN
        (* the 11 analog values, same order as the dashboard (CHANNELS in plc_buffer.py) *)
        Vals[0]  := AI_Dryer_To_Radiator_01;                (* T-01  x10  *)
        Vals[1]  := AI_Hot_Water_Tank_To_Sludge_Dryer_01;   (* T-02  x10  *)
        Vals[2]  := AI_Radiator_To_Surface_Condenser_01;    (* T-03  x10  *)
        Vals[3]  := AI_Phe_1_To_Degasifier;                 (* T-04  x10  *)
        Vals[4]  := AI_Sludge_Water_Tank;                   (* LT-01 x10  *)
        Vals[5]  := AI_Filtrate_Tank;                       (* LT-02 x10  *)
        Vals[6]  := AI_Ph_Sensor_For_Process_Water;         (* pH    x100 *)
        Vals[7]  := AI_Raw_Water_Tank_Distribution_Line;    (* PT-01 x100 *)
        Vals[8]  := AI_Dryer_To_Radiator_02;                (* PT-02 x100 *)
        Vals[9]  := AI_Hot_Water_Tank_To_Sludge_Dryer_02;   (* PT-03 x100 *)
        Vals[10] := AI_Radiator_To_Surface_Condenser_02;    (* PT-04 x100 *)

        Base := WORD_TO_INT(LOG_HDR[3]) * 12;
        LOG_REC[Base] := INT_TO_WORD(WORD_TO_INT(Rtc[2]) * 2048 + MinOfDay);   (* <<< day of month; time stamp *)
        FOR K := 0 TO 10 DO
            R := Vals[K] * Scl[K];
            IF R < 0.0 THEN R := 0.0; END_IF;
            IF R > 65534.0 THEN R := 65534.0; END_IF;       (* 65535 is reserved for "no value" *)
            LOG_REC[Base + 1 + K] := DINT_TO_WORD(REAL_TO_DINT(R));
        END_FOR;

        (* advance the ring buffer *)
        IF WORD_TO_INT(LOG_HDR[3]) >= 1049 THEN
            LOG_HDR[3] := 0;
        ELSE
            LOG_HDR[3] := INT_TO_WORD(WORD_TO_INT(LOG_HDR[3]) + 1);
        END_IF;
        IF LOG_HDR[4] = 16#FFFF THEN
            LOG_HDR[4] := 0;
            LOG_HDR[5] := INT_TO_WORD(WORD_TO_INT(LOG_HDR[5]) + 1);
        ELSE
            LOG_HDR[4] := DINT_TO_WORD(WORD_TO_DINT(LOG_HDR[4]) + 1);
        END_IF;
    END_IF;
END_IF;
